// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// The Coinbase Smart Wallet (v1.1) functions this module uses. It is an owner of the wallet, so
/// the wallet lets it add and remove owners; it cannot move funds by any other path it exposes.
interface ICoinbaseSmartWallet {
    function addOwnerPublicKey(bytes32 x, bytes32 y) external;
    function removeOwnerAtIndex(uint256 index, bytes calldata owner) external;
    function ownerAtIndex(uint256 index) external view returns (bytes memory);
}

/// @title FerraRecovery: replace a lost passkey on chain, never by Swissquote alone.
/// @notice A client's smart account (owned by their passkey) adds this contract as a second owner
/// and registers a recovery phone. To replace the passkey, three things are needed, all checked here:
///   1. the recovery phone's signature over the new passkey (the client's side);
///   2. Swissquote's attestation: the identity check passed, and the timelock it set (the smart delay);
///   3. the timelock elapsed, during which the current passkey can cancel (unless the recovery is
///      contested: a second attempt after a cancel, so a stolen passkey cannot block recovery forever).
/// The only thing this contract can do to the wallet is swap one passkey owner for another, and only
/// on that combination. It holds no funds and has no admin.
contract FerraRecovery {
    /// Swissquote's attestation key (KYC passed, delay set). Cannot act without the phone.
    address public immutable attester;
    /// Floor on the timelock (demo value; a day in production). Swissquote may only lengthen it.
    uint64 public immutable minDelay;

    struct Pending {
        bytes32 x;
        bytes32 y;
        uint256 oldIndex;
        uint64 unlockAt;
        bool contested;
    }

    /// The account's recovery phone (secp256k1 address), set by the account itself.
    mapping(address account => address phone) public phoneOf;
    mapping(address account => Pending) public pendingOf;
    /// Bumped by every start: a signature is good for one recovery only.
    mapping(address account => uint256) public nonceOf;
    /// Recoveries the current passkey cancelled: the next one is contested.
    mapping(address account => uint256) public cancelsOf;

    event PhoneSet(address indexed account, address phone);
    event RecoveryStarted(address indexed account, bytes32 x, bytes32 y, uint256 oldIndex, uint64 unlockAt, bool contested);
    event RecoveryCancelled(address indexed account);
    event RecoveryExecuted(address indexed account, bytes32 x, bytes32 y);

    error NoPhone();
    error AlreadyPending();
    error NothingPending();
    error DelayTooShort();
    error BadPhoneSignature();
    error BadAttestation();
    error Contested();
    error Timelocked(uint64 unlockAt);

    constructor(address attester_, uint64 minDelay_) {
        attester = attester_;
        minDelay = minDelay_;
    }

    /// Called by the smart account itself (a user operation its passkey signed). Zero removes it.
    function setPhone(address phone) external {
        phoneOf[msg.sender] = phone;
        emit PhoneSet(msg.sender, phone);
    }

    /// What the phone signs (EIP-191 personal message over this digest).
    function phoneDigest(address account, bytes32 x, bytes32 y, uint256 oldIndex, uint256 nonce) public view returns (bytes32) {
        return keccak256(abi.encode("FERRA-RECOVERY-PHONE-v1", block.chainid, address(this), account, x, y, oldIndex, nonce));
    }

    /// What Swissquote signs: the same recovery, plus the timelock its risk analysis set.
    function attesterDigest(address account, bytes32 x, bytes32 y, uint256 oldIndex, uint256 nonce, uint64 delay) public view returns (bytes32) {
        return keccak256(abi.encode("FERRA-RECOVERY-ATTEST-v1", block.chainid, address(this), account, x, y, oldIndex, nonce, delay));
    }

    /// Anyone may relay it; it only succeeds with both signatures.
    function start(address account, bytes32 x, bytes32 y, uint256 oldIndex, uint64 delay, bytes calldata phoneSig, bytes calldata attesterSig) external {
        if (pendingOf[account].unlockAt != 0) revert AlreadyPending();
        if (delay < minDelay) revert DelayTooShort();
        address phone = phoneOf[account];
        if (phone == address(0)) revert NoPhone();
        uint256 nonce = nonceOf[account];
        if (_recover(phoneDigest(account, x, y, oldIndex, nonce), phoneSig) != phone) revert BadPhoneSignature();
        if (_recover(attesterDigest(account, x, y, oldIndex, nonce, delay), attesterSig) != attester) revert BadAttestation();
        nonceOf[account] = nonce + 1;
        bool contested = cancelsOf[account] > 0;
        uint64 unlockAt = uint64(block.timestamp) + delay;
        pendingOf[account] = Pending(x, y, oldIndex, unlockAt, contested);
        emit RecoveryStarted(account, x, y, oldIndex, unlockAt, contested);
    }

    /// "Not me": called by the smart account itself, so only the current passkey can cancel.
    function cancel() external {
        Pending storage p = pendingOf[msg.sender];
        if (p.unlockAt == 0) revert NothingPending();
        if (p.contested) revert Contested();
        delete pendingOf[msg.sender];
        cancelsOf[msg.sender] += 1;
        emit RecoveryCancelled(msg.sender);
    }

    /// After the timelock, anyone may finish it: the new passkey is added, the old one removed, and
    /// the phone is consumed (the client registers a recovery phone again).
    function execute(address account) external {
        Pending memory p = pendingOf[account];
        if (p.unlockAt == 0) revert NothingPending();
        if (block.timestamp < p.unlockAt) revert Timelocked(p.unlockAt);
        delete pendingOf[account];
        phoneOf[account] = address(0);
        ICoinbaseSmartWallet wallet = ICoinbaseSmartWallet(account);
        bytes memory old = wallet.ownerAtIndex(p.oldIndex);
        wallet.addOwnerPublicKey(p.x, p.y);
        wallet.removeOwnerAtIndex(p.oldIndex, old);
        emit RecoveryExecuted(account, p.x, p.y);
    }

    /// EIP-191 personal-message recovery with the usual malleability checks (ecrecover precompile).
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        bytes32 hash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        return ecrecover(hash, v, r, s);
    }
}
