// SPDX-License-Identifier: AGPL-3.0-or-later

/// AutomationSwap.sol

// Copyright (C) 2021-2021 Oazo Apps Limited

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
pragma solidity ^0.8.0;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AutomationExecutor } from "../AutomationExecutor.sol";

contract AutomationSwap {
    using SafeERC20 for IERC20;

    AutomationExecutor public immutable executor;
    IERC20 public immutable dai;

    address public owner;

    mapping(address => bool) public callers;

    constructor(AutomationExecutor _executor, IERC20 _dai) {
        executor = _executor;
        dai = _dai;
        owner = msg.sender;
        callers[owner] = true;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "swap/only-owner");
        _;
    }

    modifier auth(address caller) {
        require(callers[caller], "swap/not-authorized");
        _;
    }

    function addCaller(address caller) external onlyOwner {
        callers[caller] = true;
    }

    function removeCaller(address caller) external onlyOwner {
        require(caller != msg.sender, "swap/cannot-remove-owner");
        callers[caller] = false;
    }

    function swap(
        address receiver,
        address otherAsset,
        bool toDai,
        uint256 amount,
        uint256 receiveAtLeast,
        address callee,
        bytes calldata withData
    ) external auth(msg.sender) {
        require(receiver != address(0), "swap/receiver-zero-address");
        executor.swap(otherAsset, toDai, amount, 0, callee, withData);
        IERC20 toToken = toDai ? dai : IERC20(otherAsset);
        uint256 balance = toToken.balanceOf(address(this));
        require(balance >= receiveAtLeast, "swap/received-less");
        toToken.safeTransfer(receiver, balance);
    }
}
