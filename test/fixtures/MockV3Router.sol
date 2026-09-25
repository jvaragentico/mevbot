// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMockToken {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract MockV3Router {
    mapping(bytes32 => uint256) public numerator;
    mapping(bytes32 => uint256) public denominator;

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function setRate(address input, address output, uint256 num, uint256 den) external {
        require(num > 0 && den > 0);
        bytes32 key = keccak256(abi.encode(input, output));
        numerator[key] = num;
        denominator[key] = den;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut) {
        bytes32 key = keccak256(abi.encode(params.tokenIn, params.tokenOut));
        require(denominator[key] > 0, 'rate');
        amountOut = params.amountIn * numerator[key] / denominator[key];
        require(amountOut >= params.amountOutMinimum, 'min out');
        require(IMockToken(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn));
        require(IMockToken(params.tokenOut).transfer(params.recipient, amountOut));
    }
}
