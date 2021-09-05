// SPDX-License-Identifier: GPL-3.0-or-later
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

pragma solidity ^0.8.0;

import "@mimic-fi/v1-core/contracts/interfaces/IStrategy.sol";
import "@mimic-fi/v1-core/contracts/interfaces/ISwapConnector.sol";
import "@mimic-fi/v1-core/contracts/interfaces/IPriceOracle.sol";
import "@mimic-fi/v1-core/contracts/interfaces/IVault.sol";
import "@mimic-fi/v1-core/contracts/libraries/FixedPoint.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./ICToken.sol";

contract CompoundStrategy is IStrategy {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    uint256 private constant _SLIPPAGE = 1e16; // 1%

    IVault private immutable _vault;
    IERC20 private immutable _token;
    ICToken private immutable _ctoken;

    uint256 private _totalShares;
    string private _metadataURI;

    modifier onlyVault() {
        require(address(_vault) == msg.sender, "CALLER_IS_NOT_VAULT");
        _;
    }

    constructor(
        IVault vault,
        IERC20 token,
        ICToken ctoken,
        string memory metadata
    ) {
        _token = token;
        _ctoken = ctoken;
        _vault = vault;
        _metadataURI = metadata;

        token.approve(address(vault), FixedPoint.MAX_UINT256);
        token.approve(address(ctoken), FixedPoint.MAX_UINT256);
    }

    function getVault() external view returns (address) {
        return address(_vault);
    }

    function getToken() external view override returns (address) {
        return address(_token);
    }

    function getCToken() external view returns (address) {
        return address(_ctoken);
    }

    function getMetadataURI() external view override returns (string memory) {
        return _metadataURI;
    }

    function getTokenBalance() external view override returns (uint256) {
        // Not taking into account not invested balance
        uint256 totalCToken = _ctoken.balanceOf(address(this));
        return FixedPoint.mul(totalCToken, _ctoken.exchangeRateStored());
    }

    function getTotalShares() external view override returns (uint256) {
        return _totalShares;
    }

    function onJoin(uint256 amount, bytes memory)
        external
        override
        onlyVault
        returns (uint256)
    {
        uint256 initialTokenBalance = _token.balanceOf(address(this));
        uint256 initialCTokenBalance = _ctoken.balanceOf(address(this));

        claim();
        invest(_token);

        uint256 finalCTokenBalance = _ctoken.balanceOf(address(this));

        uint256 callerCTokenAmount = amount
        .mul(finalCTokenBalance.sub(initialCTokenBalance))
        .div(initialTokenBalance);

        uint256 shares = _totalShares == 0
            ? callerCTokenAmount
            : _totalShares.mul(callerCTokenAmount).div(
                finalCTokenBalance.sub(callerCTokenAmount)
            );

        _totalShares = _totalShares.add(shares);

        return shares;
    }

    function onExit(uint256 shares, bytes memory)
        external
        override
        onlyVault
        returns (address, uint256)
    {
        claim();
        invest(_token);

        //initialTokenBalance should be awlays zero after investing, but just in case it check
        uint256 initialTokenBalance = _token.balanceOf(address(this));
        uint256 initialCTokenBalance = _ctoken.balanceOf(address(this));

        uint256 ctokenAmount = shares.mul(initialCTokenBalance).div(
            _totalShares
        );

        require(_ctoken.redeem(ctokenAmount) == 0, "COMPOUND_REDEEM_FAILED");

        uint256 finalTokenBalance = _token.balanceOf(address(this));
        uint256 tokenAmount = finalTokenBalance.sub(initialTokenBalance);

        _totalShares = _totalShares.sub(shares);

        return (address(_token), tokenAmount);
    }

    function approveVault(IERC20 token) external {
        require(address(token) != address(_ctoken), "COMPOUND_INTERNAL_TOKEN");

        token.approve(address(_vault), FixedPoint.MAX_UINT256);
    }

    function invest(IERC20 token) public {
        require(address(token) != address(_ctoken), "COMPOUND_INTERNAL_TOKEN");

        uint256 tokenBalance = token.balanceOf(address(this));

        if (token != _token) {
            _swap(token, _token, tokenBalance);
            tokenBalance = _token.balanceOf(address(this));
        }

        require(_ctoken.mint(tokenBalance) == 0, "COMPOUND_MINT_FAILED");
    }

    function claim() public {
        //TODO: claim COMP
        //swap COMP for token
    }

    //Private

    function _swap(
        IERC20 tokenIn,
        IERC20 tokenOut,
        uint256 amountIn
    ) private returns (uint256) {
        require(tokenIn != tokenOut, "SWAP_SAME_TOKEN");

        address priceOracle = _vault.priceOracle();
        address swapConnector = _vault.swapConnector();

        uint256 price = IPriceOracle(priceOracle).getTokenPrice(
            address(tokenOut),
            address(tokenIn)
        );

        uint256 minAmountOut = FixedPoint.mulUp(
            FixedPoint.mulUp(amountIn, price),
            FixedPoint.ONE - _SLIPPAGE
        );

        require(
            ISwapConnector(swapConnector).getAmountOut(
                address(tokenIn),
                address(tokenOut),
                amountIn
            ) >= minAmountOut,
            "EXPECTED_SWAP_MIN_AMOUNT"
        );

        _safeTransfer(tokenIn, swapConnector, amountIn);

        uint256 preBalanceIn = tokenIn.balanceOf(address(this));
        uint256 preBalanceOut = tokenOut.balanceOf(address(this));
        (uint256 remainingIn, uint256 amountOut) = ISwapConnector(swapConnector)
        .swap(
            address(tokenIn),
            address(tokenOut),
            amountIn,
            minAmountOut,
            block.timestamp,
            ""
        );

        require(amountOut >= minAmountOut, "SWAP_MIN_AMOUNT");

        uint256 postBalanceIn = tokenIn.balanceOf(address(this));
        // require(
        //     postBalanceIn.sub(preBalanceIn) >= remainingIn,
        //     "SWAP_INVALID_REMAINING_IN"
        // );

        uint256 postBalanceOut = tokenOut.balanceOf(address(this));
        require(
            postBalanceOut.sub(preBalanceOut) >= amountOut,
            "SWAP_INVALID_AMOUNT_OUT"
        );

        return amountOut;
    }

    function _safeTransfer(
        IERC20 token,
        address to,
        uint256 amount
    ) private {
        if (amount > 0) {
            token.safeTransfer(to, amount);
        }
    }
}
