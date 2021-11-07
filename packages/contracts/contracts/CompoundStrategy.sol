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

import '@mimic-fi/v1-vault/contracts/interfaces/IStrategy.sol';
import '@mimic-fi/v1-vault/contracts/interfaces/ISwapConnector.sol';
import '@mimic-fi/v1-vault/contracts/interfaces/IPriceOracle.sol';
import '@mimic-fi/v1-vault/contracts/interfaces/IVault.sol';
import '@mimic-fi/v1-vault/contracts/libraries/FixedPoint.sol';

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/utils/math/SafeMath.sol';
import '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import './ICToken.sol';
import './Comptroller.sol';

contract CompoundStrategy is IStrategy {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    uint256 private constant _MAX_SLIPPAGE = 1e18; // 100%

    uint256 private constant _MAX_UINT256 = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

    IVault private immutable _vault;
    IERC20 private immutable _token;
    ICToken private immutable _ctoken;
    IERC20 private immutable _comp;
    Comptroller private immutable _comptroller;
    uint256 private immutable _slippage;
    string private _metadataURI;

    uint256 private _totalShares;

    modifier onlyVault() {
        require(address(_vault) == msg.sender, 'CALLER_IS_NOT_VAULT');
        _;
    }

    constructor(
        IVault vault,
        IERC20 token,
        ICToken ctoken,
        IERC20 comp,
        Comptroller comptroller,
        uint256 slippage,
        string memory metadata
    ) {
        require(slippage <= _MAX_SLIPPAGE, 'SWAP_MAX_SLIPPAGE');

        _token = token;
        _ctoken = ctoken;
        _comp = comp;
        _comptroller = comptroller;
        _vault = vault;
        _slippage = slippage;
        _metadataURI = metadata;

        token.approve(address(vault), _MAX_UINT256);
        token.approve(address(ctoken), _MAX_UINT256);
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

    function getRate() external view override returns (uint256) {
        //TODO: remove function
        return 0;
    }

    function getTotalShares() external view override returns (uint256) {
        return _totalShares;
    }

    function onJoin(uint256 amount, bytes memory) external override onlyVault returns (uint256) {
        uint256 initialTokenBalance = _token.balanceOf(address(this));
        uint256 initialCTokenBalance = _ctoken.balanceOf(address(this));

        invest(_token);

        uint256 finalCTokenBalance = _ctoken.balanceOf(address(this));
        uint256 cTokenAmount = finalCTokenBalance.sub(initialCTokenBalance);

        uint256 callerCTokenAmount = amount.mul(cTokenAmount).div(initialTokenBalance);

        uint256 shares = _totalShares == 0
            ? callerCTokenAmount
            : _totalShares.mul(callerCTokenAmount).div(finalCTokenBalance.sub(callerCTokenAmount));

        _totalShares = _totalShares.add(shares);

        return shares;
    }

    function onExit(uint256 shares, bool, bytes memory) external override onlyVault returns (address, uint256) {
        invest(_token);

        //initialTokenBalance should be awlays zero after investing, but just in case it check
        uint256 initialTokenBalance = _token.balanceOf(address(this));
        uint256 initialCTokenBalance = _ctoken.balanceOf(address(this));

        uint256 ctokenAmount = shares.mul(initialCTokenBalance).div(_totalShares);

        //Exit is secure enough, no need for emergency exit
        require(_ctoken.redeem(ctokenAmount) == 0, 'COMPOUND_REDEEM_FAILED');

        uint256 finalTokenBalance = _token.balanceOf(address(this));
        uint256 tokenAmount = finalTokenBalance.sub(initialTokenBalance);

        _totalShares = _totalShares.sub(shares);

        return (address(_token), tokenAmount);
    }

    function approveTokenSpenders() external {
        _approveToken(address(_vault));
        _approveToken(address(_ctoken));
    }

    function invest(IERC20 token) public {
        require(address(token) != address(_ctoken), 'COMPOUND_INTERNAL_TOKEN');

        uint256 tokenBalance = token.balanceOf(address(this));

        if (token != _token) {
            if (tokenBalance > 0) {
                _swap(token, _token, tokenBalance);
            }
            tokenBalance = _token.balanceOf(address(this));
        }

        require(_ctoken.mint(tokenBalance) == 0, 'COMPOUND_MINT_FAILED');
    }

    function claim() public {
        _comptroller.claimComp(address(this));
    }

    //Private

    function _swap(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn) private returns (uint256) {
        require(tokenIn != tokenOut, 'SWAP_SAME_TOKEN');

        address priceOracle = _vault.priceOracle();
        address swapConnector = _vault.swapConnector();

        uint256 price = IPriceOracle(priceOracle).getTokenPrice(address(tokenOut), address(tokenIn));

        uint256 minAmountOut = FixedPoint.mulUp(FixedPoint.mulUp(amountIn, price), FixedPoint.ONE - _slippage);

        require(
            ISwapConnector(swapConnector).getAmountOut(address(tokenIn), address(tokenOut), amountIn) >= minAmountOut,
            'EXPECTED_SWAP_MIN_AMOUNT'
        );

        _safeTransfer(tokenIn, swapConnector, amountIn);

        uint256 preBalanceIn = tokenIn.balanceOf(address(this));
        uint256 preBalanceOut = tokenOut.balanceOf(address(this));
        (uint256 remainingIn, uint256 amountOut) = ISwapConnector(swapConnector).swap(
            address(tokenIn),
            address(tokenOut),
            amountIn,
            minAmountOut,
            block.timestamp,
            ''
        );

        require(amountOut >= minAmountOut, 'SWAP_MIN_AMOUNT');

        uint256 postBalanceIn = tokenIn.balanceOf(address(this));
        require(postBalanceIn >= preBalanceIn.add(remainingIn), 'SWAP_INVALID_REMAINING_IN');

        uint256 postBalanceOut = tokenOut.balanceOf(address(this));
        require(postBalanceOut >= preBalanceOut.add(amountOut), 'SWAP_INVALID_AMOUNT_OUT');

        return amountOut;
    }

    function _approveToken(address spender) private {
        uint256 allowance = _token.allowance(address(this), spender);
        if (allowance < _MAX_UINT256) {
            if (allowance > 0) {
                // Some tokens revert when changing non-zero approvals
                _token.approve(spender, 0);
            }
            _token.approve(spender, _MAX_UINT256);
        }
    }

    function _safeTransfer(IERC20 token, address to, uint256 amount) private {
        if (amount > 0) {
            token.safeTransfer(to, amount);
        }
    }
}
