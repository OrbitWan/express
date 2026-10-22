// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
// Test only: a plain ERC-20 standing in for XWAN (18 decimals), and a seller that tries to re-enter the desk.
contract MockXWAN {
    string public constant symbol = "XWAN"; uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    function mint(address to, uint256 v) external { balanceOf[to] += v; emit Transfer(address(0), to, v); }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; emit Transfer(msg.sender, to, v); return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); return true; }
}
interface IDesk { function sell(uint256) external returns (uint256); }
interface IApprove { function approve(address, uint256) external returns (bool); }
contract Reenter {
    IDesk public desk; uint256 public amt; bool public tried;
    constructor(address d, address x) { desk = IDesk(d); IApprove(x).approve(d, type(uint256).max); }
    function go(uint256 a) external { amt = a; desk.sell(a); }
    receive() external payable { if (!tried) { tried = true; desk.sell(amt); } }
}
