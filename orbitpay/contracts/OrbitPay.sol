// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title OrbitPay deposit turnstile
/// @notice Immutable, non-upgradeable. Users deposit whitelisted wanUSDT/wanUSDC; funds go straight to the
///         immutable treasury. An off-chain watcher credits the beneficiary from the Deposited event.
///         Event signature is frozen: keccak256("Deposited(address,address,uint256)") =
///         0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7 (must match the watcher's topic0).
contract OrbitPay {
    address public immutable treasury; // treasury == owner, immutable
    address public immutable owner;    // == treasury
    address public immutable usdt;     // whitelisted token 1 (immutable)
    address public immutable usdc;     // whitelisted token 2 (immutable)

    event Deposited(address indexed beneficiary, address indexed token, uint256 amount);

    error NotTreasury();
    error TokenNotWhitelisted();
    error AmountTooLow();
    error TransferFailed();

    constructor(address _treasury, address _usdt, address _usdc) {
        require(_treasury != address(0) && _usdt != address(0) && _usdc != address(0));
        treasury = _treasury;
        owner = _treasury;
        usdt = _usdt;
        usdc = _usdc;
    }

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert NotTreasury();
        _;
    }

    /// @notice Deposit crediting the caller.
    function deposit(address token, uint256 amount) external {
        _deposit(token, amount, msg.sender);
    }

    /// @notice Deposit crediting an explicit beneficiary.
    function depositFor(address token, uint256 amount, address beneficiary) external {
        _deposit(token, amount, beneficiary);
    }

    function _deposit(address token, uint256 amount, address beneficiary) private {
        if (token != usdt && token != usdc) revert TokenNotWhitelisted();
        if (amount < 1e6) revert AmountTooLow();
        _safeTransferFrom(token, msg.sender, treasury, amount); // pull straight to treasury, with success check
        emit Deposited(beneficiary, token, amount);
    }

    /// @notice Recover strays sent directly to this contract; treasury-only. Cannot touch the whitelist.
    function sweep(address token, address to) external onlyTreasury {
        _safeTransfer(token, to, _balanceOf(token));
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        require(ok && data.length >= 32);
        return abi.decode(data, (uint256));
    }
}
