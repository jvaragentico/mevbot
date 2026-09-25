// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol) { name = _name; symbol = _symbol; }
    function mint(address to, uint256 value) external { balanceOf[to] += value; }
    function approve(address spender, uint256 value) external returns (bool) { allowance[msg.sender][spender] = value; return true; }
    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }
}

contract MockV2Pair {
    address public immutable token0;
    address public immutable token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private timestamp;
    event Sync(uint112 reserve0, uint112 reserve1);

    constructor(address a, address b) { token0 = a; token1 = b; }
    function getReserves() external view returns (uint112, uint112, uint32) { return (reserve0, reserve1, timestamp); }
    function sync() external { _sync(); }
    function _sync() internal {
        reserve0 = uint112(MockERC20(token0).balanceOf(address(this)));
        reserve1 = uint112(MockERC20(token1).balanceOf(address(this)));
        timestamp = uint32(block.timestamp);
        emit Sync(reserve0, reserve1);
    }
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out < reserve0 && amount1Out < reserve1, 'liquidity');
        if (amount0Out != 0) require(MockERC20(token0).transfer(to, amount0Out));
        if (amount1Out != 0) require(MockERC20(token1).transfer(to, amount1Out));
        uint256 balance0 = MockERC20(token0).balanceOf(address(this));
        uint256 balance1 = MockERC20(token1).balanceOf(address(this));
        uint256 amount0In = balance0 > uint256(reserve0) - amount0Out ? balance0 - (uint256(reserve0) - amount0Out) : 0;
        uint256 amount1In = balance1 > uint256(reserve1) - amount1Out ? balance1 - (uint256(reserve1) - amount1Out) : 0;
        require(amount0In > 0 || amount1In > 0, 'input');
        require(
            (balance0 * 1000 - amount0In * 3) * (balance1 * 1000 - amount1In * 3)
              >= uint256(reserve0) * uint256(reserve1) * 1000000,
            'invariant'
        );
        _sync();
    }
}
