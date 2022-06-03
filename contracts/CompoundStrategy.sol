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

import '@openzeppelin/contracts/access/Ownable.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/utils/math/SafeMath.sol';
import '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import './compound/ICToken.sol';
import './compound/Comptroller.sol';

contract CompoundStrategy is IStrategy, Ownable {
    using SafeERC20 for IERC20;
    using FixedPoint for uint256;

    uint256 private constant MAX_SLIPPAGE = 10e16; // 10%
    uint256 private constant SWAP_THRESHOLD = 10; // 10 wei
    uint256 private constant VAULT_EXIT_RATIO_PRECISION = 1e18;

    event SetSlippage(uint256 slippage);

    IVault internal immutable _vault;
    IERC20 internal immutable _comp;
    IERC20 internal immutable _token;
    ICToken internal immutable _cToken;
    Comptroller internal immutable _comptroller;

    string internal _metadataURI;
    uint256 internal _slippage;

    modifier onlyVault() {
        require(address(_vault) == msg.sender, 'CALLER_IS_NOT_VAULT');
        _;
    }

    constructor(IVault vault, IERC20 token, ICToken cToken, uint256 slippage, string memory metadataURI) {
        _token = token;
        _cToken = cToken;
        _comp = cToken.comptroller().getCompAddress();
        _comptroller = cToken.comptroller();
        _vault = vault;
        _setSlippage(slippage);
        _setMetadataURI(metadataURI);
    }

    /**
     * @dev Tells the address of the Mimic Vault
     */
    function getVault() external view returns (address) {
        return address(_vault);
    }

    /**
     * @dev Tells the token that will be used as the strategy entry point
     */
    function getToken() external view override returns (address) {
        return address(_token);
    }

    /**
     * @dev Tells the Compound token associated to the strategy token
     */
    function getCToken() external view returns (address) {
        return address(_cToken);
    }

    /**
     * @dev Tells the COMP address
     */
    function getComp() external view returns (address) {
        return address(_comp);
    }

    /**
     * @dev Tells the address of the Compound controller
     */
    function getComptroller() external view returns (address) {
        return address(_comptroller);
    }

    /**
     * @dev Tell the slippage used to swap rewards
     */
    function getSlippage() external view returns (uint256) {
        return _slippage;
    }

    /**
     * @dev Tell the metadata URI associated to the strategy
     */
    function getMetadataURI() external view override returns (string memory) {
        return _metadataURI;
    }

    /**
     * @dev Tells how much value the strategy has over time.
     * For example, if a strategy has a value of 100 in T0, and then it has a value of 120 in T1,
     * It means it gained a 20% between T0 and T1 due to the appreciation of the C token and comp rewards.
     * Note: This function only tells the total value until the last claim
     */
    function getTotalValue() public view override returns (uint256) {
        uint256 cTokenRate = _cToken.exchangeRateStored();
        uint256 cTokenBalance = _cToken.balanceOf(address(this));
        return cTokenBalance.mulDown(cTokenRate);
    }

    /**
     * @dev Tells how much a value unit means expressed in the strategy token.
     * For example, if a strategy has a value of 100 in T0, and then it has a value of 120 in T1,
     * and the value rate is 1.5, it means the strategy has earned 30 strategy tokens between T0 and T1.
     */
    function getValueRate() external pure override returns (uint256) {
        return FixedPoint.ONE;
    }

    /**
     * @dev Setter to update the slippage
     */
    function setSlippage(uint256 newSlippage) external onlyOwner {
        _setSlippage(newSlippage);
    }

    /**
     * @dev Setter to override the existing metadata URI
     */
    function setMetadataURI(string memory metadataURI) external onlyOwner {
        _setMetadataURI(metadataURI);
    }

    /**
     * @dev Strategy onJoin hook
     */
    function onJoin(uint256 amount, bytes memory)
        external
        override
        onlyVault
        returns (uint256 value, uint256 totalValue)
    {
        claim();

        uint256 initialTokenBalance = _token.balanceOf(address(this));
        uint256 initialCTokenBalance = _cToken.balanceOf(address(this));

        invest(_token);

        uint256 finalCTokenBalance = _cToken.balanceOf(address(this));
        uint256 investedCTokenAmount = finalCTokenBalance.sub(initialCTokenBalance);
        uint256 callerCTokenAmount = SafeMath.div(SafeMath.mul(amount, investedCTokenAmount), initialTokenBalance);

        uint256 cTokenRate = _cToken.exchangeRateStored();
        value = callerCTokenAmount.mulDown(cTokenRate);
        totalValue = finalCTokenBalance.mulDown(cTokenRate);
    }

    /**
     * @dev Strategy onExit hook
     */
    function onExit(uint256 ratio, bool emergency, bytes memory)
        external
        override
        onlyVault
        returns (address token, uint256 amount, uint256 value, uint256 totalValue)
    {
        // Invest before exiting only if it is a non-emergency exit
        if (!emergency) {
            claim();
            invest(_token);
        }

        uint256 initialTokenBalance = _token.balanceOf(address(this));
        uint256 initialCTokenBalance = _cToken.balanceOf(address(this));

        uint256 cTokenAmount = SafeMath.div(initialCTokenBalance.mulDown(ratio), VAULT_EXIT_RATIO_PRECISION);
        require(_cToken.redeem(cTokenAmount) == 0, 'COMPOUND_REDEEM_FAILED');

        uint256 finalCTokenBalance = _cToken.balanceOf(address(this));
        uint256 finalTokenBalance = _token.balanceOf(address(this));
        uint256 tokenAmount = finalTokenBalance.sub(initialTokenBalance);
        _token.approve(address(_vault), tokenAmount);

        uint256 cTokenRate = _cToken.exchangeRateStored();
        value = tokenAmount.mulDown(cTokenRate);
        totalValue = finalCTokenBalance.mulDown(cTokenRate);
        return (address(_token), tokenAmount, value, totalValue);
    }

    /**
     * @dev Claims Compound rewards and swap them for the strategy token.
     */
    function claim() public {
        // TODO: check non-zero
        // Claim COMP and swap for strategy token
        _comptroller.claimComp(address(this));
        _swap(_comp, _token, _comp.balanceOf(address(this)));
    }

    /**
     * @dev Invest all the balance of a token in the strategy into Compound.
     * If the requested token is not the same token as the strategy token it will be swapped before joining the pool.
     * This method is marked as public so it can be used externally by anyone in case of an airdrop.
     */
    function invest(IERC20 token) public {
        require(token != _cToken, 'COMPOUND_INTERNAL_TOKEN');

        if (token != _token) {
            uint256 amountIn = token.balanceOf(address(this));
            _swap(token, _token, amountIn);
        }

        uint256 amount = _token.balanceOf(address(this));
        if (amount == 0) return;
        _token.approve(address(_cToken), amount);
        require(_cToken.mint(amount) == 0, 'COMPOUND_MINT_FAILED');
    }

    /**
     * @dev Claims and invest rewards.
     * @return Current total value after investing all accrued rewards.
     */
    function claimAndInvest() external returns (uint256) {
        claim();
        invest(_token);
        return getTotalValue();
    }

    /**
     * @dev Internal function to swap a pair of tokens using the Vault's swap connector
     */
    function _swap(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn) internal {
        if (amountIn == 0) return;
        require(tokenIn != tokenOut, 'SWAP_SAME_TOKEN');

        IPriceOracle priceOracle = IPriceOracle(_vault.priceOracle());
        uint256 price = priceOracle.getTokenPrice(address(tokenOut), address(tokenIn));
        uint256 minAmountOut = amountIn.mulUp(price).mulUp(FixedPoint.ONE - _slippage);
        if (minAmountOut < SWAP_THRESHOLD) return;

        address swapConnector = _vault.swapConnector();
        tokenIn.safeTransfer(swapConnector, amountIn);

        uint256 preBalanceIn = tokenIn.balanceOf(address(this));
        uint256 preBalanceOut = tokenOut.balanceOf(address(this));
        (uint256 remainingIn, uint256 amountOut) = ISwapConnector(swapConnector).swap(
            address(tokenIn),
            address(tokenOut),
            amountIn,
            minAmountOut,
            block.timestamp,
            new bytes(0)
        );

        require(amountOut >= minAmountOut, 'SWAP_MIN_AMOUNT');
        uint256 postBalanceIn = tokenIn.balanceOf(address(this));
        require(postBalanceIn >= preBalanceIn.add(remainingIn), 'SWAP_INVALID_REMAINING_IN');
        uint256 postBalanceOut = tokenOut.balanceOf(address(this));
        require(postBalanceOut >= preBalanceOut.add(amountOut), 'SWAP_INVALID_AMOUNT_OUT');
    }

    /**
     * @dev Internal function to set the metadata URI
     */
    function _setMetadataURI(string memory newMetadataURI) private {
        _metadataURI = newMetadataURI;
        emit SetMetadataURI(newMetadataURI);
    }

    /**
     * @dev Internal function to set the slippage
     */
    function _setSlippage(uint256 newSlippage) private {
        require(newSlippage <= MAX_SLIPPAGE, 'SLIPPAGE_ABOVE_MAX');
        _slippage = newSlippage;
        emit SetSlippage(newSlippage);
    }
}
