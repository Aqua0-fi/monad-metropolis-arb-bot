// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

// forgefmt: disable-start
//
//         █████╗  ██████╗ ██╗   ██╗ █████╗  ██████╗
//        ██╔══██╗██╔═══██╗██║   ██║██╔══██╗██╔═████╗
//        ███████║██║   ██║██║   ██║███████║██║██╔██║
//        ██╔══██║██║▄▄ ██║██║   ██║██╔══██║████╔╝██║
//        ██║  ██║╚██████╔╝╚██████╔╝██║  ██║╚██████╔╝
//        ╚═╝  ╚═╝ ╚══▀▀═╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝
//
//        Cross-Chain Shared Liquidity Protocol
//
// forgefmt: disable-end

import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { Errors } from "../lib/Errors.sol";
import { Events } from "../lib/Events.sol";

/// @title FillerRegistry
/// @author Aqua0 Team
/// @notice Self-service on-chain participation registry for LP fillers. Any LP can
///         toggle their own participation state, and the emitted event is indexed by
///         the backend to determine JIT routing eligibility.
/// @dev Non-upgradeable, no admin, no owner. Anyone may toggle their own state via
///      `setParticipation`; a meta-tx variant carries the same intent under an EIP-712
///      signature so a relayer can submit on the LP's behalf.
///
///      CONSENT IS OPT-IN AND FAILS CLOSED. `isParticipating[lp]` is `false` until the
///      LP calls `setParticipation(true)`; consumers MUST read the boolean literally, and
///      an absent row (or a read error) is NOT participating. The flag gates cross-chain
///      FRONTING, where being a candidate lets an LP's principal be pledged to stand in
///      for a stranger's capital, so eligibility must always be the LP's own affirmative
///      action. Any default-participating reading would enrol every depositor into
///      fronting without their consent.
contract FillerRegistry {
    // ============ EIP-712 constants ============

    /// @notice EIP-712 typehash for the SetParticipation struct.
    /// @dev `deadline` is included so a relayer or anyone in possession of a signed
    ///      meta-transaction cannot replay it indefinitely while the LP's nonce stays put
    ///      All other Aqua0 signed payloads (Withdraw, RepaymentWithdraw,
    ///      JIT) already carry deadlines; this keeps the schema consistent.
    bytes32 public constant SET_PARTICIPATION_TYPEHASH =
        keccak256("SetParticipation(address lp,bool active,uint256 nonce,uint256 deadline)");

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant DOMAIN_NAME_HASH = keccak256("Aqua0FillerRegistry");

    /// @notice EIP-712 domain version hash, `keccak256(version)`, bound at construction.
    /// @dev A deploy parameter, not a constant, because name, chainId and verifyingContract are all
    ///      reproducible off a fork: a fork keeps the forked chain's id, and CREATE3 lands this at the same
    ///      address on every chain, so without a distinct version a meta-transaction signed against a fork
    ///      deployment is structurally valid against the mainnet one. Mainnet passes `"1"` (the frozen wire
    ///      value the LP signs against); a fork passes something else.
    bytes32 public immutable DOMAIN_VERSION_HASH;

    // ============ Constructor ============

    /// @notice Bind the EIP-712 domain version.
    /// @param domainVersion The domain version; `"1"` on mainnet, a distinct value on a fork so a fork-minted
    ///                      opt-in cannot validate against the mainnet deployment. Empty is refused, since it
    ///                      is what an omitted argument passes.
    constructor(string memory domainVersion) {
        require(bytes(domainVersion).length != 0, Errors.EmptyDomainVersion());
        DOMAIN_VERSION_HASH = keccak256(bytes(domainVersion));
    }

    // ============ Storage ============

    /// @notice Whether an LP has explicitly opted in to JIT routing and fronting.
    /// @dev OPT-IN, read literally: `false` (including the default for an LP who has
    ///      never called `setParticipation`) means NOT participating. Only an explicit
    ///      `setParticipation(true)` makes an LP a candidate. See the contract-level
    ///      note: the inverse reading would make every depositor frontable by default.
    ///      `participationNonce` distinguishes "never set" from "explicitly set false"
    ///      for indexing and audit; it is NOT an input to the eligibility decision.
    mapping(address => bool) public isParticipating;

    /// @notice Monotonically increasing nonce per LP, used for replay protection on
    ///         EIP-712 meta-transactions.
    mapping(address => uint256) public participationNonce;

    // ============ Events ============

    // ============ External state-changing ============

    /// @notice Toggle the caller's own participation state. The nonce is incremented
    ///         before emitting so that the event nonce matches `participationNonce[lp]`
    ///         after the call.
    /// @param active True to participate in JIT routing, false to opt out.
    function setParticipation(bool active) external {
        unchecked {
            // Overflow unreachable: a per-account monotonic counter, one increment per call.
            participationNonce[msg.sender] += 1;
        }
        isParticipating[msg.sender] = active;
        emit Events.FillerParticipationSet(msg.sender, active, participationNonce[msg.sender]);
    }

    /// @notice EIP-712 meta-transaction variant. A relayer or paymaster may submit a
    ///         participation toggle on behalf of `lp`, provided the LP signed the
    ///         canonical digest off-chain.
    /// @dev Nonce must equal `participationNonce[lp] + 1` (next expected nonce). This
    ///      prevents replay and enforces ordering. The recovered signer must equal `lp`.
    ///      `deadline` bounds the signature's lifetime: a relayer holding a signed
    ///      payload cannot replay it after `block.timestamp > deadline` even if the
    ///      LP's nonce hasn't advanced.
    /// @param lp       The LP whose state is being set.
    /// @param active   The new participation state.
    /// @param nonce    The next nonce for `lp` (must equal `participationNonce[lp] + 1`).
    /// @param deadline Unix timestamp after which this signed payload is no longer valid.
    /// @param v        ECDSA signature component.
    /// @param r        ECDSA signature component.
    /// @param s        ECDSA signature component.
    function setParticipationFor(
        address lp,
        bool active,
        uint256 nonce,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // A 65-byte `(r, s, v)` blob is what `SignatureChecker` expects; the split-component form is the same
        // signature in a narrower encoding, so both arities verify through one implementation.
        setParticipationFor(lp, active, nonce, deadline, abi.encodePacked(r, s, v));
    }

    /// @notice EIP-712 meta-transaction variant taking an opaque signature, so a smart-contract
    ///         wallet can opt in.
    /// @dev Verified with `SignatureChecker`, which accepts an EOA `ecrecover` signature AND an
    ///      ERC-1271 contract wallet. The split `(v, r, s)` overload cannot express the latter at
    ///      all: a contract wallet has no private key, so nothing recovers to its address and the
    ///      documented opt-in is unreachable for it. LPs and strategists are smart wallets, and every
    ///      other user-facing signature surface in the protocol already verifies this way.
    ///
    ///      The signed digest is unchanged: same `SET_PARTICIPATION_TYPEHASH`, same domain separator.
    ///      Only the calldata encoding of the signature differs.
    ///
    ///      ERC-1271 validity is evaluated at execution time, so a wallet that rotates its signer can
    ///      invalidate a signature it already issued. That is the standard's semantics and the
    ///      intended behaviour for a consent flag: the wallet's CURRENT authority decides.
    /// @param lp        The LP whose state is being set.
    /// @param active    The new participation state.
    /// @param nonce     The next nonce for `lp` (must equal `participationNonce[lp] + 1`).
    /// @param deadline  Unix timestamp after which this signed payload is no longer valid.
    /// @param signature EOA (65-byte) or ERC-1271 signature over the canonical digest.
    function setParticipationFor(address lp, bool active, uint256 nonce, uint256 deadline, bytes memory signature)
        public
    {
        require(lp != address(0), Errors.ZeroAddress());
        require(block.timestamp <= deadline, Errors.ExpiredDeadline(deadline, block.timestamp));
        require(nonce == participationNonce[lp] + 1, Errors.MetaTxNonceMismatch(nonce, participationNonce[lp] + 1));

        bytes32 structHash = keccak256(abi.encode(SET_PARTICIPATION_TYPEHASH, lp, active, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        // `SignatureChecker` returns false rather than reverting on a malformed or high-s signature,
        // and only then falls back to ERC-1271. Both failures land on the same custom error, so the
        // caller cannot tell a bad EOA signature from a refused contract signature: an invalid
        // signature is one outcome.
        require(SignatureChecker.isValidSignatureNow(lp, digest, signature), Errors.MetaTxSignatureInvalid());

        participationNonce[lp] = nonce;
        isParticipating[lp] = active;
        emit Events.FillerParticipationSet(lp, active, nonce);
    }

    // ============ Internal views ============

    /// @notice Compute the EIP-712 domain separator for this contract.
    /// @dev Chain-id and verifying-contract are bound at call-time so this contract
    ///      works correctly across forked chains without a constructor or storage slot.
    /// @return The EIP-712 domain separator for the current chain and this contract address.
    function _domainSeparator() internal view returns (bytes32) {
        return
            keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, block.chainid, address(this)));
    }
}
