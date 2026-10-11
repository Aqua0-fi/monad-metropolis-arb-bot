#!/usr/bin/env python3
"""ONE owner command for a short, self-terminating Monad (143) V4 pilot run.

  python3 ops/owner-timed-run-monad.py --minutes 10            # execute window (interactive)
  python3 ops/owner-timed-run-monad.py --minutes 10 --observe  # no signing, no onchain writes
  python3 ops/owner-timed-run-monad.py --close-only            # turn the executor OFF now

Execute mode: read-only preflight -> typed RUN MONAD <N> MIN -> onchain setActiveUntil(now + N min +
grace) and setPaused(false) -> worker with --max-runtime-ms plus a hard wall-clock kill of its whole
process group -> ALWAYS (finally / signals / atexit) setPaused(true) + setActiveUntil(0), verified ->
summary. Even if this script, the laptop or the session dies, the contract stops trading by itself at
activeUntil. --minutes is capped at 60.
"""
import argparse
import atexit
import datetime
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import owner_monad_common as common  # noqa: E402

POLICY = json.loads((common.ROOT / 'config' / 'monad-owner-pilot.json').read_text())
MAX_MINUTES = min(60, int(POLICY['window']['maxMinutes']))
KILL_SLACK_SECONDS = int(POLICY['window']['killSlackSeconds'])
TERM_GRACE_SECONDS = 10
EXIT_OK, EXIT_FAIL, EXIT_PREFLIGHT, EXIT_NOT_CLOSED = 0, 1, 2, 3


class Interrupted(Exception):
    """A signal arrived; unwind into the finally path that turns the executor OFF."""


def parse(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--minutes', type=int, help='run length, 1..%d' % MAX_MINUTES)
    parser.add_argument('--observe', action='store_true', help='no signing and no onchain writes')
    parser.add_argument('--close-only', action='store_true', help='only turn the executor OFF (pause + activeUntil 0)')
    parser.add_argument('--rpc', help='explicit RPC for this run AND the worker (default: free %s for owner calls; '
                        'the worker uses the registry publicRpc)' % common.DEFAULT_RPC)
    parser.add_argument('--state-dir')
    parser.add_argument('--registry', help='worker registry (default config/chains.json)')
    # Test-only switches; each is refused unless --rpc is a 127.0.0.1 anvil fork.
    parser.add_argument('--signer', choices=['kms', 'anvil-test'], default='kms', help=argparse.SUPPRESS)
    parser.add_argument('--test-worker', help=argparse.SUPPRESS)
    parser.add_argument('--test-confirm', help=argparse.SUPPRESS)
    parser.add_argument('--secrets-dir', help=argparse.SUPPRESS)
    parser.add_argument('--test-api-url', help=argparse.SUPPRESS)
    parser.add_argument('--test-worker-home', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.close_only:
        if args.observe or args.minutes is not None:
            raise common.OwnerRefusal('--close-only takes no --minutes or --observe')
    else:
        if args.minutes is None or args.minutes < 1 or args.minutes > MAX_MINUTES:
            raise common.OwnerRefusal('--minutes must be an integer from 1 to %d' % MAX_MINUTES)
    loopback = args.rpc is not None and common.is_loopback(args.rpc)
    for flag, value in (('--signer anvil-test', args.signer == 'anvil-test'), ('--test-worker', args.test_worker),
                        ('--test-confirm', args.test_confirm is not None), ('--secrets-dir', args.secrets_dir),
                        ('--test-api-url', args.test_api_url), ('--test-worker-home', args.test_worker_home)):
        if value and not loopback:
            raise common.OwnerRefusal('%s is test-only and requires --rpc http://127.0.0.1:<port>' % flag)
    return args


class TimedRun:
    def __init__(self, args, run_node=None, environ=None, reader=input, out=common.emit):
        self.args = args
        self.mode = 'close-only' if args.close_only else ('observe' if args.observe else 'execute')
        self.environ = dict(os.environ if environ is None else environ)
        self.reader = reader
        self.out = out
        self.run_node = run_node or self._run_node
        self.rpc = common.validate_rpc(args.rpc or common.DEFAULT_RPC, self.environ)
        self.worker_rpc_explicit = args.rpc is not None
        self.run_id = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        self.state_dir = Path(args.state_dir).resolve() if args.state_dir else common.ROOT / 'runtime' / 'monad-pilot'
        self.run_dir = self.state_dir / 'runs' / self.run_id
        self.worker = None
        self.open_attempted = False
        self.closed_verified = False
        self.stopping = False
        self.deferring = False
        self.pending_signal = None
        self.owner_env = None
        self.worker_env = None
        self.started_ms = None

    # -- credentials (names only; values never printed) -------------------------------------------
    def load_credentials(self):
        if self.mode == 'execute' and self.args.signer == 'kms':
            common.require_interactive('An execute window')
        if self.mode == 'close-only' and self.args.signer == 'kms':
            common.require_interactive('Signing the close transactions')
        secrets = Path(self.args.secrets_dir) if self.args.secrets_dir else common.SECRETS
        base = common.scrubbed_env(self.environ)
        aws = {}
        if self.mode in ('execute', 'close-only') and self.args.signer == 'kms':
            aws = common.load_aws_env(secrets / common.AWS_ENV_FILE.name)
        worker = dict(base)
        if self.mode != 'close-only':
            read_key = common.load_json_key(secrets / common.READ_KEY_FILE.name, 'AQUA0_READ_API_KEY')
            if read_key is None:
                raise common.OwnerRefusal('The read-tier key file %s is missing; the worker cannot run'
                                          % (secrets / common.READ_KEY_FILE.name))
            worker['AQUA0_READ_API_KEY'] = read_key
        if self.mode == 'execute':
            operator_key = common.load_json_key(secrets / common.OPERATOR_KEY_FILE.name, 'AQUA0_OPERATOR_API_KEY')
            if operator_key is None:
                raise common.OwnerRefusal(
                    'AQUA0_OPERATOR_API_KEY is missing (%s does not exist). Execute mode is refused because V4 '
                    'authorize needs the operator tier. Observe mode still works: add --observe.'
                    % (secrets / common.OPERATOR_KEY_FILE.name))
            worker['AQUA0_OPERATOR_API_KEY'] = operator_key
            worker.update(aws)
        if self.worker_rpc_explicit:
            worker[common.PAID_RPC_ENV] = self.rpc  # owner-chosen and allowlist-checked
        self.worker_env = worker
        self.owner_env = dict(base, **aws)

    # -- node helpers ------------------------------------------------------------------------------
    def common_flags(self):
        flags = ['--rpc', self.rpc, '--signer', self.args.signer, '--state-dir', str(self.state_dir),
                 '--run-id', self.run_id]
        if self.args.registry:
            flags += ['--registry', self.args.registry]
        return flags

    def _run_node(self, args, env, interactive=False, timeout=600):
        # Owner calls run in their own session: a terminal Ctrl-C reaches only this supervisor, which lets an
        # in-flight owner transaction finish and then runs the close path.
        return subprocess.run(common.node_command('owner-window-monad.ts', *args), cwd=common.ROOT, env=env,
                              stdin=None if interactive else subprocess.DEVNULL, timeout=timeout,
                              start_new_session=True, check=False).returncode

    # -- signals -----------------------------------------------------------------------------------
    def on_signal(self, signum, _frame):
        if self.stopping:
            self.out('Signal %d ignored: turning the executor OFF is in progress; please wait.' % signum)
            return
        if self.deferring:
            self.pending_signal = signum
            self.out('Signal %d received: stopping right after the in-flight owner transaction settles.' % signum)
            return
        raise Interrupted(signum)

    def install_signals(self):
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, self.on_signal)
        atexit.register(self.ensure_closed)  # also covers an unexpected exception escaping run()

    # -- worker ------------------------------------------------------------------------------------
    def worker_home(self):
        # The worker keeps its journal, history and backend-budget ledger under <home>/runtime. Owner runs use
        # the repository (persistent across runs); tests use an isolated home so fork data never mixes in.
        return Path(self.args.test_worker_home).resolve() if self.args.test_worker_home else common.ROOT

    def worker_command(self):
        config = str(self.run_dir / 'worker.json')
        runtime_ms = str(self.args.minutes * 60_000)
        if self.args.test_worker:
            return [sys.executable, str(Path(self.args.test_worker).resolve()), config, runtime_ms]
        registry = str(Path(self.args.registry).resolve()) if self.args.registry else str(common.ROOT / 'config' / 'chains.json')
        return ['node', '--import', str(common.ROOT / 'node_modules' / 'tsx' / 'dist' / 'loader.mjs'),
                str(common.ROOT / 'src' / 'cli.ts'), 'run', '--config', config, '--chain', '143',
                '--max-runtime-ms', runtime_ms, '--registry', registry]

    def launch_worker(self):
        log_path = self.run_dir / 'worker.log'
        self.log_path = log_path
        log = open(log_path, 'ab')
        os.chmod(log_path, 0o600)
        self.worker = subprocess.Popen(self.worker_command(), cwd=self.worker_home(), env=self.worker_env,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       start_new_session=True)

        def tee():
            for line in iter(self.worker.stdout.readline, b''):
                log.write(line)
                log.flush()
                sys.stdout.write(line.decode('utf-8', 'replace'))
                sys.stdout.flush()
            log.close()
            self.worker.stdout.close()
        self.tee = threading.Thread(target=tee, daemon=True)
        self.tee.start()
        self.out('Worker started (pid %d, own process group); hard stop in %d s.'
                 % (self.worker.pid, self.args.minutes * 60 + KILL_SLACK_SECONDS))

    def signal_worker_group(self, sig):
        try:
            os.killpg(self.worker.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

    def stop_worker(self):
        if self.worker is None or self.worker.poll() is not None:
            return
        self.out('Stopping the worker process group (SIGTERM)...')
        self.signal_worker_group(signal.SIGTERM)
        try:
            self.worker.wait(timeout=TERM_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            self.out('Worker did not stop; SIGKILL to its process group.')
            self.signal_worker_group(signal.SIGKILL)
            self.worker.wait(timeout=10)
        # Reap any straggler still in the group.
        self.signal_worker_group(signal.SIGKILL)

    def supervise(self):
        deadline = time.monotonic() + self.args.minutes * 60 + KILL_SLACK_SECONDS
        while self.worker.poll() is None:
            if time.monotonic() >= deadline:
                self.out('Wall-clock limit reached.')
                self.stop_worker()
                break
            time.sleep(0.5)
        if getattr(self, 'tee', None):
            self.tee.join(timeout=5)
        return self.worker.returncode

    # -- onchain safety close ----------------------------------------------------------------------
    def ensure_closed(self):
        if self.mode == 'observe' or self.closed_verified or (self.mode == 'execute' and not self.open_attempted):
            return self.closed_verified
        self.stopping = True
        for attempt in range(1, 4):
            self.out('Turning the executor OFF: setPaused(true) + setActiveUntil(0) (attempt %d)...' % attempt)
            try:
                if self.run_node(['close'] + self.common_flags(), self.owner_env) == 0 and \
                        self.run_node(['status'] + self.common_flags(), self.owner_env) == 0:
                    self.closed_verified = True
                    self.out('Verified onchain: executor paused with activeUntil = 0.')
                    return True
            except Exception as exc:  # keep trying: this is the safety path
                self.out('Close attempt failed: %s' % type(exc).__name__)
            time.sleep(5 * attempt)
        self.out('!' * 78)
        self.out('EXECUTOR NOT VERIFIED OFF. It still stops trading by itself at its onchain activeUntil.')
        self.out('Run now: python3 ops/owner-timed-run-monad.py --close-only')
        self.out('!' * 78)
        return False

    # -- main flow ---------------------------------------------------------------------------------
    def prepare_dirs(self):
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.state_dir, 0o700)
        self.run_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    def run(self):
        self.load_credentials()
        self.prepare_dirs()
        if self.mode == 'close-only':
            self.open_attempted = True
            return EXIT_OK if self.ensure_closed() else EXIT_NOT_CLOSED
        preflight = ['preflight', '--mode', self.mode, '--minutes', str(self.args.minutes)] + self.common_flags()
        if self.worker_rpc_explicit:
            preflight.append('--worker-rpc-explicit')
        if self.args.test_api_url:
            preflight += ['--api-url', self.args.test_api_url]
        # Presence check only; the explicit worker RPC was already allowlist-checked against the owner's shell.
        preflight_env = {k: v for k, v in dict(self.worker_env, **self.owner_env).items() if k != common.PAID_RPC_ENV}
        if self.run_node(preflight, preflight_env) != 0:
            self.out('Preflight refused. Nothing was signed and nothing onchain changed.')
            return EXIT_PREFLIGHT
        if self.mode == 'execute':
            phrase = 'RUN MONAD %d MIN' % self.args.minutes
            prompt = ('This opens a %d-minute onchain trading window (plus grace) on Monad, runs the worker, '
                      'then pauses the executor and sets activeUntil = 0.' % self.args.minutes)
            confirmed = (self.args.test_confirm == phrase) if self.args.test_confirm is not None \
                else common.typed_confirmation(prompt, phrase, self.reader)
            if not confirmed:
                self.out('Cancelled. Nothing was signed and nothing onchain changed.')
                return EXIT_FAIL
        self.install_signals()
        status = EXIT_OK
        try:
            opened = True
            if self.mode == 'execute':
                self.open_attempted = True
                phrase = 'RUN MONAD %d MIN' % self.args.minutes
                self.deferring = True
                try:
                    opened = self.run_node(['open', '--minutes', str(self.args.minutes), '--confirm', phrase]
                                           + self.common_flags(), self.owner_env, interactive=True) == 0
                finally:
                    self.deferring = False
                if self.pending_signal is not None:
                    raise Interrupted(self.pending_signal)
                if not opened:
                    self.out('Opening the window failed; turning the executor OFF.')
                    status = EXIT_FAIL
            if opened:
                self.started_ms = int(time.time() * 1000)
                self.launch_worker()
                code = self.supervise()
                self.out('Worker exited with code %s.' % code)
                if code not in (0, None):
                    status = EXIT_FAIL
        except Interrupted as signum:
            self.out('Interrupted by signal %s; stopping.' % signum)
            status = EXIT_FAIL
        finally:
            self.stopping = True
            self.stop_worker()
            if self.mode == 'execute' and self.open_attempted and not self.ensure_closed():
                status = EXIT_NOT_CLOSED
        self.summary()
        return status

    def summary(self):
        since = self.started_ms or int(time.time() * 1000) - 60_000
        args = ['summary', '--since', str(since), '--worker-home', str(self.worker_home())] + self.common_flags()
        if getattr(self, 'log_path', None):
            args += ['--worker-log', str(self.log_path)]
        try:
            self.run_node(args, self.owner_env, timeout=180)
        except Exception as exc:
            self.out('Summary unavailable: %s' % type(exc).__name__)


def main(argv=None):
    args = parse(argv)
    run = TimedRun(args)
    common.emit('Monad timed run %s: mode=%s rpc=%s' % (run.run_id, run.mode, run.rpc if common.is_loopback(run.rpc)
                                                        else run.rpc.split('//', 1)[-1].split('/', 1)[0]))
    return run.run()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, common.OwnerRefusal) as exc:
        common.fail(exc)
