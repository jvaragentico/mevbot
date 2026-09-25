// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @notice Atomic WETH -> token -> WETH arbitrage across two 0.30% Uniswap V2-compatible pairs.
/// @dev Only the owner can execute. Nonstandard or fee-on-transfer tokens are unsupported.
contract AtomicV2Arb {
    address public immutable owner;
    address public immutable weth;
    address public immutable token;

    event ArbExecuted(address indexed buyPair, address indexed sellPair, uint256 amountIn, uint256 grossProfit);
    event RouteExecuted(bytes32 indexed routeHash, uint256 amountIn, uint256 grossProfit);

    error Unauthorized();
    error InvalidPair();
    error NotProfitable();
    error TransferFailed();

    constructor(address _weth, address _token) {
        if (_weth == address(0) || _token == address(0) || _weth == _token) revert InvalidPair();
        owner = msg.sender;
        weth = _weth;
        token = _token;
    }

    function execute(address buyPair, address sellPair, uint256 amountIn, uint256 minGrossProfit)
        external returns (uint256 grossProfit)
    {
        if (msg.sender != owner) revert Unauthorized();
        if (buyPair == sellPair || amountIn == 0) revert InvalidPair();
        _checkPair(buyPair);
        _checkPair(sellPair);

        uint256 startingWeth = IERC20(weth).balanceOf(address(this));
        uint256 startingToken = IERC20(token).balanceOf(address(this));
        _safeTransferFrom(weth, owner, buyPair, amountIn);

        uint256 tokenOut = _getAmountOut(amountIn, _reserve(buyPair, weth), _reserve(buyPair, token));
        _swap(buyPair, token, tokenOut, sellPair);
        uint256 wethOut = _getAmountOut(tokenOut, _reserve(sellPair, token), _reserve(sellPair, weth));
        _swap(sellPair, weth, wethOut, address(this));

        uint256 endingWeth = IERC20(weth).balanceOf(address(this));
        if (endingWeth < startingWeth + amountIn + minGrossProfit) revert NotProfitable();
        if (IERC20(token).balanceOf(address(this)) != startingToken) revert InvalidPair();
        grossProfit = endingWeth - startingWeth - amountIn;
        _safeTransfer(weth, owner, amountIn + grossProfit);
        emit ArbExecuted(buyPair, sellPair, amountIn, grossProfit);
    }

    /// @notice Execute a two- to four-hop V2 cycle ending in WETH.
    /// @dev Intermediate tokens move directly between pairs; no inventory is held between hops.
    function executeRoute(address[] calldata pairs, address[] calldata path, uint256 amountIn, uint256 minGrossProfit)
        external returns (uint256 grossProfit)
    {
        if (msg.sender != owner) revert Unauthorized();
        if (pairs.length < 2 || pairs.length > 4 || path.length != pairs.length + 1 || amountIn == 0) revert InvalidPair();
        if (path[0] != weth || path[path.length - 1] != weth) revert InvalidPair();
        for (uint256 i = 0; i < pairs.length; i++) {
            if (path[i] == path[i + 1]) revert InvalidPair();
            for (uint256 j = 0; j < i; j++) if (pairs[i] == pairs[j]) revert InvalidPair();
            _reservesFor(pairs[i], path[i], path[i + 1]);
        }

        uint256 startingWeth = IERC20(weth).balanceOf(address(this));
        _safeTransferFrom(weth, owner, pairs[0], amountIn);
        uint256 amount = amountIn;
        for (uint256 i = 0; i < pairs.length; i++) {
            (uint256 reserveIn, uint256 reserveOut) = _reservesFor(pairs[i], path[i], path[i + 1]);
            amount = _getAmountOut(amount, reserveIn, reserveOut);
            _swap(pairs[i], path[i + 1], amount, i + 1 < pairs.length ? pairs[i + 1] : address(this));
        }
        uint256 endingWeth = IERC20(weth).balanceOf(address(this));
        if (endingWeth < startingWeth + amountIn + minGrossProfit) revert NotProfitable();
        grossProfit = endingWeth - startingWeth - amountIn;
        _safeTransfer(weth, owner, amountIn + grossProfit);
        emit RouteExecuted(keccak256(abi.encode(pairs, path)), amountIn, grossProfit);
    }

    function _reservesFor(address pair, address input, address output)
        private view returns (uint256 reserveIn, uint256 reserveOut)
    {
        if (pair == address(0)) revert InvalidPair();
        address a = IV2Pair(pair).token0();
        address b = IV2Pair(pair).token1();
        (uint112 r0, uint112 r1,) = IV2Pair(pair).getReserves();
        if (a == input && b == output) return (r0, r1);
        if (a == output && b == input) return (r1, r0);
        revert InvalidPair();
    }

    function _checkPair(address pair) private view {
        if (pair == address(0)) revert InvalidPair();
        address a = IV2Pair(pair).token0();
        address b = IV2Pair(pair).token1();
        if (!((a == weth && b == token) || (a == token && b == weth))) revert InvalidPair();
    }

    function _reserve(address pair, address asset) private view returns (uint256) {
        (uint112 r0, uint112 r1,) = IV2Pair(pair).getReserves();
        return IV2Pair(pair).token0() == asset ? r0 : r1;
    }

    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        private pure returns (uint256)
    {
        if (reserveIn == 0 || reserveOut == 0) revert InvalidPair();
        uint256 amountWithFee = amountIn * 997;
        return (amountWithFee * reserveOut) / (reserveIn * 1000 + amountWithFee);
    }

    function _swap(address pair, address assetOut, uint256 amountOut, address to) private {
        if (amountOut == 0) revert NotProfitable();
        if (IV2Pair(pair).token0() == assetOut) IV2Pair(pair).swap(amountOut, 0, to, "");
        else IV2Pair(pair).swap(0, amountOut, to, "");
    }

    function _safeTransfer(address asset, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address asset, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
