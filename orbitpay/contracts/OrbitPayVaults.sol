// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title OrbitPay cross-chain vault lane
/// @notice Per-beneficiary CREATE2 "vaults" turn an address-only cross-chain transfer (bridge tokens to a
///         deterministic vault address, no WAN and no destination calldata needed) into an attributed OrbitPay
///         credit. A keeper calls Factory.collect(beneficiary, token); the vault approves OrbitPay and calls
///         depositFor(token, balance, beneficiary), so the existing OrbitPay contract and deposit watcher change
///         by zero bytes and the beneficiary is credited from the standard Deposited(beneficiary, token, amount).
///
///         Determinism law: the vault takes NO constructor arguments (it reads orbitpay + beneficiary back from the
///         factory via parameters() during construction), so type(OrbitPayVault).creationCode — and therefore its
///         keccak256 init code hash — is CONSTANT across all beneficiaries. The CREATE2 address depends only on
///         (factory, salt=beneficiary, initCodeHash). The vault endpoint embeds that one init code hash.

interface IOrbitPay {
    function depositFor(address token, uint256 amount, address beneficiary) external;
}

interface IVaultParameters {
    function parameters() external view returns (address orbitpay, address beneficiary);
}

/// @notice Minimal per-beneficiary vault. No owner, no receive/fallback. Immutables set from the factory callback.
contract OrbitPayVault {
    address public immutable orbitpay;
    address public immutable beneficiary;

    error ApproveFailed();

    constructor() {
        (orbitpay, beneficiary) = IVaultParameters(msg.sender).parameters();
    }

    /// @notice Sweep this vault's full balance of `token` into OrbitPay, credited to `beneficiary`.
    ///         Reverts inside OrbitPay if `token` is not whitelisted or balance < 1e6 (AmountTooLow).
    function collect(address token) external {
        uint256 bal = _balanceOf(token);
        _safeApprove(token, orbitpay, bal);
        IOrbitPay(orbitpay).depositFor(token, bal, beneficiary);
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        require(ok && data.length >= 32);
        return abi.decode(data, (uint256));
    }
}

/// @notice Immutable factory. Deterministic salt = beneficiary. Deploys vaults on demand and drives collects.
contract OrbitPayVaultFactory {
    address public immutable orbitpay;

    /// @dev Transient constructor channel read by OrbitPayVault's constructor (keeps vault creationCode arg-free).
    struct Parameters {
        address orbitpay;
        address beneficiary;
    }
    Parameters public parameters;

    event VaultDeployed(address indexed beneficiary, address vault);
    event Collected(address indexed beneficiary, address indexed token, address vault);

    constructor(address _orbitpay) {
        require(_orbitpay != address(0));
        orbitpay = _orbitpay;
    }

    /// @notice Deterministic vault address for a beneficiary (CREATE2), whether or not it is deployed yet.
    function vaultOf(address beneficiary) public view returns (address) {
        bytes32 salt = bytes32(uint256(uint160(beneficiary)));
        bytes32 h = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(type(OrbitPayVault).creationCode))
        );
        return address(uint160(uint256(h)));
    }

    /// @notice Deploy the vault if absent, then collect `token` into OrbitPay for `beneficiary`. Permissionless:
    ///         funds always route to the beneficiary's own OrbitPay credit regardless of who calls.
    function collect(address beneficiary, address token) external {
        address vault = vaultOf(beneficiary);
        if (vault.code.length == 0) {
            parameters = Parameters({orbitpay: orbitpay, beneficiary: beneficiary});
            bytes32 salt = bytes32(uint256(uint160(beneficiary)));
            OrbitPayVault deployed = new OrbitPayVault{salt: salt}();
            delete parameters;
            require(address(deployed) == vault, "CREATE2 mismatch");
            emit VaultDeployed(beneficiary, vault);
        }
        OrbitPayVault(vault).collect(token);
        emit Collected(beneficiary, token, vault);
    }
}
