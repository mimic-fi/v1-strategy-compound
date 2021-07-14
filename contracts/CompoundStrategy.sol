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
import "@mimic-fi/v1-core/contracts/helpers/FixedPoint.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./ICToken.sol";

contract CompoundStrategy is IStrategy {
    using FixedPoint for uint256;

    address public immutable vault;
    IERC20 public immutable token;
    ICToken public immutable ctoken;

    uint256 private _totalShares;
    string private _metadataURI;

    constructor(address _vault, IERC20 _token, ICToken _ctoken, string memory _metadata) {
        token = _token;
        ctoken = _ctoken;
        vault = _vault;
        _metadataURI = _metadata;

        _token.approve(_vault, FixedPoint.MAX_UINT256);
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
        uint256 totalCDAI = ctoken.balanceOf(address(this));
        return totalCDAI.mul(ctoken.exchangeRateStored());
    }

    function getTotalShares() external view override returns (uint256) {
        return _totalShares;
    }

    function onJoin(uint256 amount, bytes memory) external override returns (uint256) {
        uint256 initialCTokenAmount = ctoken.balanceOf(address(this));
        require(ctoken.mint(amount) == 0, "COMPOUND_MINT_FAILED");
        uint256 finalCTokenAmount = ctoken.balanceOf(address(this));

        uint256 shares = finalCTokenAmount.sub(initialCTokenAmount);
        _totalShares = _totalShares.add(shares);
        return shares;
    }

    function onExit(uint256 shares, bytes memory) external override returns (address, uint256) {
        uint256 initialTokenAmount = token.balanceOf(address(this));
        uint256 initialCTokenAmount = ctoken.balanceOf(address(this));
        uint256 ctokenAmount = shares.mul(initialCTokenAmount).divDown(_totalShares);
        require(ctoken.redeem(ctokenAmount) == 0, "COMPOUND_REDEEM_FAILED");

        uint256 finalTokenAmount = token.balanceOf(address(this));
        uint256 amount = finalTokenAmount.sub(initialTokenAmount);
        _totalShares = _totalShares.sub(shares);
        return (address(token), amount);
    }

    function approveVault(IERC20 _token) external {
        if (address(_token) != address(ctoken)) {
            _token.approve(vault, FixedPoint.MAX_UINT256);
        }
    }
}
