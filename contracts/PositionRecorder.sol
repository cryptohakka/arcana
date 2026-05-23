// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract PositionRecorder {
    address public agent;

    event PositionOpened(
        address indexed eoa,
        uint256 amount,
        string vault,
        string regime,
        uint256 timestamp
    );
    event PositionClosed(
        address indexed eoa,
        string reason,
        uint256 timestamp
    );

    modifier onlyAgent() {
        require(msg.sender == agent, "not agent");
        _;
    }

    constructor() {
        agent = msg.sender;
    }

    function recordOpen(
        address eoa,
        uint256 amount,
        string calldata vault,
        string calldata regime
    ) external onlyAgent {
        emit PositionOpened(eoa, amount, vault, regime, block.timestamp);
    }

    function recordClose(
        address eoa,
        string calldata reason
    ) external onlyAgent {
        emit PositionClosed(eoa, reason, block.timestamp);
    }
}
