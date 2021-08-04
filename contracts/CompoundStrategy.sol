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
import "@mimic-fi/v1-core/contracts/interfaces/IVault.sol";
import "@mimic-fi/v1-core/contracts/helpers/FixedPoint.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";

import "./ICToken.sol";

contract CompoundStrategy is IStrategy {
    using FixedPoint for uint256;

    IVault public immutable vault;
    IERC20 public immutable token;
    ICToken public immutable ctoken;

    uint256 private _totalShares;
    string private _metadataURI;

    modifier onlyVault() {
        require(address(vault) == msg.sender, "CALLER_IS_NOT_VAULT");
        _;
    }

    constructor(IVault _vault, IERC20 _token, ICToken _ctoken, string memory _metadata) {
        token = _token;
        ctoken = _ctoken;
        vault = _vault;
        _metadataURI = _metadata;

        _token.approve(address(_vault), FixedPoint.MAX_UINT256);
        _token.approve(address(_ctoken), FixedPoint.MAX_UINT256);
    }

    function getToken() external view override returns (address) {
        return address(token);
    }

    function getMetadataURI() external view override returns (string memory) {
        return _metadataURI;
    }

    function getTokenBalance() external view override returns (uint256) {
        // Not taking into account not invested balance
        uint256 totalCToken = ctoken.balanceOf(address(this));
        return totalCToken.mul(ctoken.exchangeRateStored());
    }

    function getTotalShares() external view override returns (uint256) {
        return _totalShares;
    }

    function onJoin(uint256 amount, bytes memory) external override  onlyVault returns (uint256) {
        uint256 initialTokenBalance = token.balanceOf(address(this));
        uint256 initialCTokenAmount = ctoken.balanceOf(address(this));

        investAll();

        uint256 finalCTokenAmount = ctoken.balanceOf(address(this));
        uint256 callerCTokenAmount = amount.mul(finalCTokenAmount.sub(initialCTokenAmount)).div(initialTokenBalance);

        uint256 rate = _totalShares == 0? FixedPoint.ONE: _totalShares.div(finalCTokenAmount);
        uint256 shares = callerCTokenAmount.mul(rate);
        _totalShares = _totalShares.add(shares);
        return shares;
    }

    function onExit(uint256 shares, bytes memory) external override onlyVault returns (address, uint256) {
        investAll();

        uint256 initialTokenAmount = token.balanceOf(address(this));
        uint256 initialCTokenAmount = ctoken.balanceOf(address(this));
        
        //TODO: too much garbage, why?
        //uint256 ctokenAmount = shares.mul(initialCTokenAmount).divDown(_totalShares);
        uint256 ctokenAmount = SafeMath.div(SafeMath.mul(shares, initialCTokenAmount), _totalShares);

        require(ctoken.redeem(ctokenAmount) == 0, "COMPOUND_REDEEM_FAILED");

        uint256 finalTokenAmount = token.balanceOf(address(this));
        uint256 amount = finalTokenAmount.sub(initialTokenAmount);
        _totalShares = _totalShares.sub(shares);
        return (address(token), amount);
    }

    function approveVault(IERC20 _token) external {
        require(address(_token) != address(ctoken), "COMPOUND_INTERNAL_TOKEN");
        _token.approve(address(vault), FixedPoint.MAX_UINT256);
    }

    function tradeForToken(IERC20 _tokenIn) public {
        require(address(_tokenIn) != address(ctoken), "COMPOUND_INTERNAL_TOKEN");
        require(address(_tokenIn) != address(token), "COMPOUND_INTERNAL_TOKEN");

        uint256 tokenInBalance = _tokenIn.balanceOf(address(this));

        if(tokenInBalance > 0) {
            uint256 deadline = block.timestamp + 5 minutes; //TODO, also optional

            address swapConnector = vault.swapConnector();
            
            _tokenIn.transfer(swapConnector, tokenInBalance);

            ISwapConnector(swapConnector).swap(
                address(_tokenIn),
                address(token),
                tokenInBalance,
                0, //TODO: should be check by connector using oracle
                deadline,
                ""
            );
        }
    }

    function investAll() public {
        uint256 tokenBalance = token.balanceOf(address(this));
        if(tokenBalance > 0) {
            _invest(tokenBalance);
        }
    }

    function tradeAndInvest(IERC20 _token) public {
        tradeForToken(_token);
        investAll();
    }


    //Internal

    function _invest(uint256 amount) internal {
        require(ctoken.mint(amount) == 0, "COMPOUND_MINT_FAILED");
    }
}
