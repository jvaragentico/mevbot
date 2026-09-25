// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Mixed {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IV2PairMixed {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IV3RouterMixed {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Owner-only atomic WETH arbitrage between one standard V2 pair and one V3 pool.
contract AtomicV2V3Arb {
    address public immutable owner;
    address public immutable weth;
    address public immutable token;
    address public immutable v2Pair;
    address public immutable v3Router;
    uint24 public immutable v3Fee;

    event MixedRouteExecuted(uint8 indexed direction, uint256 amountIn, uint256 grossProfit);

    error Unauthorized();
    error InvalidConfiguration();
    error NotProfitable();
    error TransferFailed();
    error TransferMismatch();

    constructor(address _weth, address _token, address _v2Pair, address _v3Router, uint24 _v3Fee) {
        if (_weth == address(0) || _token == address(0) || _weth == _token ||
            _v2Pair == address(0) || _v3Router == address(0) || _v3Fee == 0 || _v3Fee >= 1_000_000) {
            revert InvalidConfiguration();
        }
        address a = IV2PairMixed(_v2Pair).token0();
        address b = IV2PairMixed(_v2Pair).token1();
        if (!((a == _weth && b == _token) || (a == _token && b == _weth))) revert InvalidConfiguration();
        owner = msg.sender;
        weth = _weth;
        token = _token;
        v2Pair = _v2Pair;
        v3Router = _v3Router;
        v3Fee = _v3Fee;
    }

    /// @notice Buy the token in V3, sell it in V2, and return WETH plus profit to the owner.
    function executeV3ToV2(uint256 amountIn, uint256 minGrossProfit) external returns (uint256 grossProfit) {
        _checkOwnerAndAmount(amountIn);
        uint256 startingWeth = IERC20Mixed(weth).balanceOf(address(this));
        uint256 startingToken = IERC20Mixed(token).balanceOf(address(this));
        _transferFrom(weth, owner, address(this), amountIn);
        _approve(weth, v3Router, amountIn);
        uint256 tokenOut = IV3RouterMixed(v3Router).exactInputSingle(IV3RouterMixed.ExactInputSingleParams({
            tokenIn: weth, tokenOut: token, fee: v3Fee, recipient: address(this),
            amountIn: amountIn, amountOutMinimum: 1, sqrtPriceLimitX96: 0
        }));
        if (tokenOut == 0 || IERC20Mixed(token).balanceOf(address(this)) != startingToken + tokenOut) revert TransferMismatch();
        (uint256 reserveToken, uint256 reserveWeth) = _reserves(token, weth);
        uint256 wethOut = _getAmountOut(tokenOut, reserveToken, reserveWeth);
        _transfer(token, v2Pair, tokenOut);
        _swap(weth, wethOut);
        if (IERC20Mixed(token).balanceOf(address(this)) != startingToken) revert TransferMismatch();
        grossProfit = _settle(startingWeth, amountIn, minGrossProfit);
        emit MixedRouteExecuted(0, amountIn, grossProfit);
    }

    /// @notice Buy the token in V2, sell it in V3, and return WETH plus profit to the owner.
    function executeV2ToV3(uint256 amountIn, uint256 minGrossProfit) external returns (uint256 grossProfit) {
        _checkOwnerAndAmount(amountIn);
        uint256 startingWeth = IERC20Mixed(weth).balanceOf(address(this));
        uint256 startingToken = IERC20Mixed(token).balanceOf(address(this));
        (uint256 reserveWeth, uint256 reserveToken) = _reserves(weth, token);
        uint256 tokenOut = _getAmountOut(amountIn, reserveWeth, reserveToken);
        _transferFrom(weth, owner, v2Pair, amountIn);
        _swap(token, tokenOut);
        if (IERC20Mixed(token).balanceOf(address(this)) != startingToken + tokenOut) revert TransferMismatch();
        _approve(token, v3Router, tokenOut);
        IV3RouterMixed(v3Router).exactInputSingle(IV3RouterMixed.ExactInputSingleParams({
            tokenIn: token, tokenOut: weth, fee: v3Fee, recipient: address(this),
            amountIn: tokenOut, amountOutMinimum: 1, sqrtPriceLimitX96: 0
        }));
        if (IERC20Mixed(token).balanceOf(address(this)) != startingToken) revert TransferMismatch();
        grossProfit = _settle(startingWeth, amountIn, minGrossProfit);
        emit MixedRouteExecuted(1, amountIn, grossProfit);
    }

    function _checkOwnerAndAmount(uint256 amountIn) private view {
        if (msg.sender != owner) revert Unauthorized();
        if (amountIn == 0) revert InvalidConfiguration();
    }

    function _reserves(address input, address output) private view returns (uint256 reserveIn, uint256 reserveOut) {
        (uint112 r0, uint112 r1,) = IV2PairMixed(v2Pair).getReserves();
        if (IV2PairMixed(v2Pair).token0() == input && IV2PairMixed(v2Pair).token1() == output) return (r0, r1);
        return (r1, r0);
    }

    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) revert InvalidConfiguration();
        uint256 withFee = amountIn * 997;
        uint256 amountOut = withFee * reserveOut / (reserveIn * 1000 + withFee);
        if (amountOut == 0) revert NotProfitable();
        return amountOut;
    }

    function _swap(address output, uint256 amountOut) private {
        if (IV2PairMixed(v2Pair).token0() == output) IV2PairMixed(v2Pair).swap(amountOut, 0, address(this), "");
        else IV2PairMixed(v2Pair).swap(0, amountOut, address(this), "");
    }

    function _settle(uint256 startingWeth, uint256 amountIn, uint256 minGrossProfit) private returns (uint256 grossProfit) {
        uint256 endingWeth = IERC20Mixed(weth).balanceOf(address(this));
        if (endingWeth < startingWeth + amountIn + minGrossProfit) revert NotProfitable();
        grossProfit = endingWeth - startingWeth - amountIn;
        _transfer(weth, owner, amountIn + grossProfit);
    }

    function _approve(address asset, address spender, uint256 amount) private {
        _callToken(asset, abi.encodeWithSelector(IERC20Mixed.approve.selector, spender, 0));
        _callToken(asset, abi.encodeWithSelector(IERC20Mixed.approve.selector, spender, amount));
    }

    function _transfer(address asset, address to, uint256 amount) private {
        _callToken(asset, abi.encodeWithSelector(IERC20Mixed.transfer.selector, to, amount));
    }

    function _transferFrom(address asset, address from, address to, uint256 amount) private {
        _callToken(asset, abi.encodeWithSelector(IERC20Mixed.transferFrom.selector, from, to, amount));
    }

    function _callToken(address asset, bytes memory data) private {
        (bool ok, bytes memory ret) = asset.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
