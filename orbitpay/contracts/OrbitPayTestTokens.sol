// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
// Test only: ERC-20 stand-ins with 6 decimals like wanUSDT and wanUSDC. MockToken returns true like most tokens,
// NoReturnToken returns nothing like USDT on Ethereum, and FalseToken answers approve and every transfer with false.
contract MockToken {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    function mint(address to, uint256 v) external { balanceOf[to] += v; emit Transfer(address(0), to, v); }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; emit Transfer(msg.sender, to, v); return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); return true; }
}
contract NoReturnToken {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 v) external { balanceOf[to] += v; }
    function approve(address s, uint256 v) external { allowance[msg.sender][s] = v; }
    function transfer(address to, uint256 v) external { balanceOf[msg.sender] -= v; balanceOf[to] += v; }
    function transferFrom(address f, address to, uint256 v) external { allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; }
}
contract FalseToken {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 v) external { balanceOf[to] += v; }
    function approve(address, uint256) external pure returns (bool) { return false; }
    function transfer(address, uint256) external pure returns (bool) { return false; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return false; }
}
