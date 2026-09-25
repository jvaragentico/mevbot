// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IVerifiedERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
    function transferFrom(address,address,uint256) external returns (bool);
    function approve(address,uint256) external returns (bool);
}
interface IVerifiedV2Factory { function getPair(address,address) external view returns (address); }
interface IVerifiedV3Factory { function getPool(address,address,uint24) external view returns (address); }
interface IVerifiedV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112,uint112,uint32);
    function swap(uint256,uint256,address,bytes calldata) external;
}
interface IVerifiedV3Router {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

/// @notice Reusable owner-only atomic WETH arbitrage for official V2/V3 pool pairs.
contract AtomicVerifiedMixedArb {
    address public immutable owner;
    address public immutable weth;
    address public immutable v2Factory;
    address public immutable v3Factory;
    address public immutable v3Router;

    event VerifiedMixedExecuted(address indexed token, address indexed v2Pair, uint24 fee, uint8 direction, uint256 amountIn, uint256 grossProfit);
    error Unauthorized();
    error InvalidRoute();
    error NotProfitable();
    error TransferFailed();
    error TransferMismatch();

    constructor(address _weth, address _v2Factory, address _v3Factory, address _v3Router) {
        if (_weth == address(0) || _v2Factory == address(0) || _v3Factory == address(0) || _v3Router == address(0)) revert InvalidRoute();
        owner = msg.sender;
        weth = _weth;
        v2Factory = _v2Factory;
        v3Factory = _v3Factory;
        v3Router = _v3Router;
    }

    /// @param direction 0 buys token in V3 and sells in V2; 1 buys in V2 and sells in V3.
    function execute(address token, address v2Pair, uint24 fee, uint8 direction, uint256 amountIn, uint256 minGrossProfit)
        external returns (uint256 grossProfit)
    {
        if (msg.sender != owner) revert Unauthorized();
        if (token == address(0) || token == weth || amountIn == 0 || fee == 0 || direction > 1) revert InvalidRoute();
        if (v2Pair == address(0) || IVerifiedV2Factory(v2Factory).getPair(weth, token) != v2Pair) revert InvalidRoute();
        if (IVerifiedV3Factory(v3Factory).getPool(weth, token, fee) == address(0)) revert InvalidRoute();
        uint256 startingWeth = IVerifiedERC20(weth).balanceOf(address(this));
        uint256 startingToken = IVerifiedERC20(token).balanceOf(address(this));
        if (direction == 0) {
            _transferFrom(weth, owner, address(this), amountIn);
            _approve(weth, v3Router, amountIn);
            uint256 tokenOut = _v3Swap(weth, token, fee, amountIn);
            if (tokenOut == 0 || IVerifiedERC20(token).balanceOf(address(this)) != startingToken + tokenOut) revert TransferMismatch();
            (uint256 reserveToken, uint256 reserveWeth) = _reserves(v2Pair, token);
            uint256 wethOut = _getAmountOut(tokenOut, reserveToken, reserveWeth);
            _transfer(token, v2Pair, tokenOut);
            _v2Swap(v2Pair, weth, wethOut);
        } else {
            (uint256 reserveWeth, uint256 reserveToken) = _reserves(v2Pair, weth);
            uint256 tokenOut = _getAmountOut(amountIn, reserveWeth, reserveToken);
            _transferFrom(weth, owner, v2Pair, amountIn);
            _v2Swap(v2Pair, token, tokenOut);
            if (IVerifiedERC20(token).balanceOf(address(this)) != startingToken + tokenOut) revert TransferMismatch();
            _approve(token, v3Router, tokenOut);
            _v3Swap(token, weth, fee, tokenOut);
        }
        if (IVerifiedERC20(token).balanceOf(address(this)) != startingToken) revert TransferMismatch();
        uint256 endingWeth = IVerifiedERC20(weth).balanceOf(address(this));
        if (endingWeth < startingWeth + amountIn + minGrossProfit) revert NotProfitable();
        grossProfit = endingWeth - startingWeth - amountIn;
        _transfer(weth, owner, amountIn + grossProfit);
        emit VerifiedMixedExecuted(token, v2Pair, fee, direction, amountIn, grossProfit);
    }

    function _v3Swap(address input, address output, uint24 fee, uint256 amountIn) private returns (uint256) {
        return IVerifiedV3Router(v3Router).exactInputSingle(IVerifiedV3Router.ExactInputSingleParams({
            tokenIn: input, tokenOut: output, fee: fee, recipient: address(this),
            amountIn: amountIn, amountOutMinimum: 1, sqrtPriceLimitX96: 0
        }));
    }

    function _reserves(address pair, address input) private view returns (uint256 reserveIn, uint256 reserveOut) {
        (uint112 r0, uint112 r1,) = IVerifiedV2Pair(pair).getReserves();
        return IVerifiedV2Pair(pair).token0() == input ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) revert InvalidRoute();
        uint256 withFee = amountIn * 997;
        uint256 output = withFee * reserveOut / (reserveIn * 1000 + withFee);
        if (output == 0) revert NotProfitable();
        return output;
    }

    function _v2Swap(address pair, address output, uint256 amountOut) private {
        if (IVerifiedV2Pair(pair).token0() == output) IVerifiedV2Pair(pair).swap(amountOut, 0, address(this), "");
        else IVerifiedV2Pair(pair).swap(0, amountOut, address(this), "");
    }

    function _approve(address asset, address spender, uint256 amount) private {
        _callToken(asset, abi.encodeWithSelector(IVerifiedERC20.approve.selector, spender, 0));
        _callToken(asset, abi.encodeWithSelector(IVerifiedERC20.approve.selector, spender, amount));
    }
    function _transfer(address asset, address to, uint256 amount) private {
        _callToken(asset, abi.encodeWithSelector(IVerifiedERC20.transfer.selector, to, amount));
    }
    function _transferFrom(address asset, address from, address to, uint256 amount) private {
        _callToken(asset, abi.encodeWithSelector(IVerifiedERC20.transferFrom.selector, from, to, amount));
    }
    function _callToken(address asset, bytes memory data) private {
        (bool ok, bytes memory ret) = asset.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
