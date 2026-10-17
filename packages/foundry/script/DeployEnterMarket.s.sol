// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./DeployHelpers.s.sol";
import "../contracts/EnterMarket.sol";

/**
 * @notice Deploy script for EnterMarket
 * Example:
 * yarn deploy --file DeployEnterMarket.s.sol --network monadTestnet
 */
contract DeployEnterMarket is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
        // the market agent's address signs event passes; unset leaves voting open (local chain)
        new EnterMarket(vm.envOr("GATEKEEPER", address(0)));
    }
}
