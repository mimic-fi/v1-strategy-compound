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

import './CompoundStrategy.sol';

contract CompoundStrategyFactory {
    event StrategyCreated(CompoundStrategy strategy);

    IVault public vault;

    constructor(IVault _vault) {
        vault = _vault;
    }

    function create(
        IERC20 token,
        ICToken ctoken,
        IERC20 comp,
        Comptroller comptroller,
        uint256 slippage,
        string memory metadata
    ) external returns (CompoundStrategy strategy) {
        strategy = new CompoundStrategy(vault, token, ctoken, comp, comptroller, slippage, metadata);
        emit StrategyCreated(strategy);
    }
}
