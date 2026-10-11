"""Shared guards for the owner-run Monad (143) helpers.

Credentials are read only by name from owner-only files and passed to child processes through the
environment, never through arguments, logs or the terminal. The backend's PAID RPC shares the env name
RPC_URL_MAINNET_MONAD, so every child starts from an environment without it.
"""
import json
import os
import shlex
import stat
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
SECRETS = Path('/Users/rithikkumars/CodingStuff/Aqua0/secrets')
AWS_ENV_FILE = SECRETS / 'market-rebalancer.aws.env'
READ_KEY_FILE = SECRETS / 'market-rebalancer-observer.json'
OPERATOR_KEY_FILE = SECRETS / 'market-rebalancer-operator.json'
DEFAULT_RPC = 'https://rpc2.monad.xyz'
PAID_RPC_ENV = 'RPC_URL_MAINNET_MONAD'
FREE_MONAD_RPC_HOSTS = {
    'rpc.monad.xyz', 'rpc1.monad.xyz', 'rpc2.monad.xyz', 'rpc3.monad.xyz', 'rpc-mainnet.monadinfra.com',
}
AWS_NAMES = {'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION',
             'MARKET_REBALANCER_KMS_KEY_ID', 'MARKET_REBALANCER_OPERATOR_ADDRESS'}
SCRUB_PREFIXES = ('AWS_', 'MARKET_REBALANCER_', 'REBALANCER_', 'AQUA0_', 'ETH_', 'RPC_URL_', 'WS_URL_', 'MONAD_PILOT_')


class OwnerRefusal(RuntimeError):
    """A refusal before any credential, signature or onchain write."""


def is_loopback(url):
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    return parsed.scheme == 'http' and parsed.hostname == '127.0.0.1'


def validate_rpc(url, environ=None):
    """Free public Monad endpoints or a 127.0.0.1 fork only; never the paid env endpoint."""
    environ = os.environ if environ is None else environ
    paid = environ.get(PAID_RPC_ENV, '').strip().rstrip('/')
    if paid and paid == url.strip().rstrip('/'):
        raise OwnerRefusal('The RPC equals RPC_URL_MAINNET_MONAD (the backend paid endpoint); use a free endpoint')
    if is_loopback(url):
        return url
    parsed = urlparse(url)
    if (parsed.scheme != 'https' or parsed.hostname not in FREE_MONAD_RPC_HOSTS or parsed.username
            or parsed.password or parsed.path not in ('', '/') or parsed.query):
        raise OwnerRefusal('RPC is not on the free Monad allowlist (%s) or a 127.0.0.1 fork'
                           % ', '.join(sorted(FREE_MONAD_RPC_HOSTS)))
    return url


def scrubbed_env(environ=None):
    environ = os.environ if environ is None else environ
    env = {k: v for k, v in environ.items() if not k.startswith(SCRUB_PREFIXES)}
    env.update(AWS_CONFIG_FILE='/dev/null', AWS_SHARED_CREDENTIALS_FILE='/dev/null', AWS_EC2_METADATA_DISABLED='true')
    return env


def _private_file(path):
    info = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() \
            or stat.S_IMODE(info.st_mode) & 0o077:
        raise OwnerRefusal('%s must be a regular owner-only (600) file' % path.name)
    if info.st_size > 65536:
        raise OwnerRefusal('%s is unexpectedly large' % path.name)


def load_aws_env(path=AWS_ENV_FILE):
    """Only the dedicated KMS credential names; values are never printed."""
    if not path.exists():
        raise OwnerRefusal('The dedicated KMS credential file %s is missing' % path)
    _private_file(path)
    out = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#') or '=' not in line:
            continue
        name, value = line.split('=', 1)
        name = name.strip()
        if name not in AWS_NAMES:
            continue
        parts = shlex.split(value)
        if len(parts) != 1 or name in out:
            raise OwnerRefusal('Ambiguous dedicated credential syntax')
        out[name] = parts[0]
    for required in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION',
                     'MARKET_REBALANCER_KMS_KEY_ID', 'MARKET_REBALANCER_OPERATOR_ADDRESS'):
        if not out.get(required):
            raise OwnerRefusal('The dedicated KMS credential file lacks %s' % required)
    return out


def load_json_key(path, name):
    """Read exactly one named key from an owner-only JSON secret file. Returns None if the file is absent."""
    if not path.exists():
        return None
    _private_file(path)
    value = json.loads(path.read_text()).get(name)
    if not isinstance(value, str) or not value.strip():
        raise OwnerRefusal('%s does not contain %s' % (path.name, name))
    return value


def interactive():
    return os.isatty(0) and os.isatty(1)


def require_interactive(what):
    if not interactive():
        raise OwnerRefusal('%s requires the owner at an interactive terminal' % what)


def typed_confirmation(prompt, expected, reader=input):
    answer = reader('%s\nType %s to proceed: ' % (prompt, expected))
    return answer == expected


def node_command(script, *args):
    return ['node', '--import', 'tsx', str(ROOT / 'scripts' / script), *args]


def emit(message):
    print(message, flush=True)


def fail(exc):
    emit('Owner helper stopped: %s' % exc)
    sys.exit(1)
