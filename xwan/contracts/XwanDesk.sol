// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title XWAN desk
/// @notice Immutable, non-upgradeable. Buys XWAN for WAN at a fixed ratio.
///         sell(amount): the seller's XWAN goes straight to the immutable treasury and the desk pays
///         amount * rate / 1e18 WAN from its own balance, in the same transaction. If the desk holds too
///         little WAN, or the desk is closed (rate 0), the whole call reverts and the seller keeps its XWAN.
///         The desk never holds XWAN. WAN top-ups arrive as plain transfers (receive).
///         rate can never reach 1 WAN per XWAN: WAN converts to XWAN 1:1 on XFlows, so a rate at or above 1
///         would let anyone convert WAN and drain the desk.
contract XwanDesk {
    uint256 public constant MAX_RATE = 0.95e18; // WAN wei per 1 XWAN (1e18), hard cap

    address public immutable xwan;
    address public immutable treasury;
    address public immutable admin;
    uint256 public rate; // WAN wei paid per 1 XWAN (1e18); 0 = closed

    uint256 private locked = 1;

    event Sold(address indexed seller, uint256 xwanAmount, uint256 wanAmount, uint256 rate);
    event RateSet(uint256 rate);
    event Funded(address indexed from, uint256 amount);
    event Swept(address indexed token, uint256 amount); // token zero = WAN

    error NotAdmin();
    error Closed();
    error ZeroPayout();
    error RateTooHigh();
    error TransferFailed();
    error Reentrant();

    constructor(address _xwan, address _treasury, address _admin, uint256 _rate) {
        require(_xwan != address(0) && _treasury != address(0) && _admin != address(0));
        if (_rate > MAX_RATE) revert RateTooHigh();
        xwan = _xwan;
        treasury = _treasury;
        admin = _admin;
        rate = _rate;
        emit RateSet(_rate);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrant();
        locked = 2;
        _;
        locked = 1;
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice WAN wei the desk would pay for xwanAmount XWAN at the current rate.
    function quote(uint256 xwanAmount) public view returns (uint256) {
        return xwanAmount * rate / 1e18;
    }

    /// @notice Approve xwanAmount XWAN to this desk first. Pays quote(xwanAmount) WAN to the caller.
    function sell(uint256 xwanAmount) external nonReentrant returns (uint256 wanAmount) {
        if (rate == 0) revert Closed();
        wanAmount = quote(xwanAmount);
        if (wanAmount == 0) revert ZeroPayout();
        _tokenCall(xwan, abi.encodeWithSelector(0x23b872dd, msg.sender, treasury, xwanAmount)); // transferFrom
        (bool ok, ) = payable(msg.sender).call{value: wanAmount}("");
        if (!ok) revert TransferFailed();
        emit Sold(msg.sender, xwanAmount, wanAmount, rate);
    }

    /// @notice Admin only. 0 closes the desk; never above MAX_RATE.
    function setRate(uint256 newRate) external onlyAdmin {
        if (newRate > MAX_RATE) revert RateTooHigh();
        rate = newRate;
        emit RateSet(newRate);
    }

    /// @notice Admin only. Sends the desk's whole WAN balance to the treasury.
    function sweep() external onlyAdmin nonReentrant {
        uint256 bal = address(this).balance;
        (bool ok, ) = payable(treasury).call{value: bal}("");
        if (!ok) revert TransferFailed();
        emit Swept(address(0), bal);
    }

    /// @notice Admin only. Sends any token sent here by mistake to the treasury.
    function sweepToken(address token) external onlyAdmin nonReentrant {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this))); // balanceOf
        require(ok && data.length >= 32);
        uint256 bal = abi.decode(data, (uint256));
        _tokenCall(token, abi.encodeWithSelector(0xa9059cbb, treasury, bal)); // transfer
        emit Swept(token, bal);
    }

    function _tokenCall(address token, bytes memory payload) private {
        (bool ok, bytes memory data) = token.call(payload);
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
