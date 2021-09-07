// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import "./CENNZnetBridge.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";

// Provides an ERC20/GA CENNZnet peg
// - depositing: lock ERC20 tokens to redeem CENNZnet "generic asset" 1:1
// - withdrawing: burn GAs to withdraw ERC20 tokens 1:1
contract ERC20Peg is Ownable {
    using SafeMath for uint256;
    // whether the peg is accepting deposits
    bool public depositsActive;
    // whether CENNZ deposists are on
    bool public cennzDepositsActive;
    // whether the peg is accepting withdrawals
    bool public withdrawalsActive;
    // CENNZnet bridge contract address
    CENNZnetBridge public bridge;

    constructor(address _bridge) {
        bridge = CENNZnetBridge(_bridge);
    }

    event Deposit(address indexed, address tokenType, uint256 amount, bytes32 cennznetAddress);
    event Withdraw(address indexed, address tokenType, uint256 amount);

    // Deposit amount of tokenType
    // the pegged version of the token will be claim-able on CENNZnet
    function deposit(address tokenType, uint256 amount, bytes32 cennznetAddress) external {
        require(depositsActive, "deposits paused");
        require(amount > 0, "0 deposit");

        // CENNZ deposits will require a vote to activate
        if (address(tokenType) == 0x1122B6a0E00DCe0563082b6e2953f3A943855c1F) {
            require(cennzDepositsActive, "cennz deposits paused");
        }

        require(IERC20(tokenType).transferFrom(msg.sender, address(this), amount), "deposit failed");

        emit Deposit(msg.sender, tokenType, amount, cennznetAddress);
    }

    // Withdraw tokens from this contract
    // Requires signatures from a threshold of current CENNZnet validators
    // v,r,s are sparse arrays expected to align w public key in 'validators'
    // i.e. v[i], r[i], s[i] matches the i-th validator[i]
    function withdraw(address tokenType, uint256 amount, address recipient, CENNZnetEventProof memory proof) payable external {
        require(withdrawalsActive, "withdrawals paused");
        bytes memory message = abi.encode(tokenType, amount, recipient, proof.validatorSetId, proof.eventId);
        bridge.verifyMessage{ value: msg.value }(message, proof);
        require(IERC20(tokenType).transfer(recipient, amount), "withdraw failed");

        emit Withdraw(recipient, tokenType, amount);
    }

    function activateCENNZDeposits() external onlyOwner {
        cennzDepositsActive = true;
    }

    function activateDeposits() external onlyOwner {
        depositsActive = true;
    }

    function pauseDeposits() external onlyOwner {
        depositsActive = false;
    }

    function activateWithdrawals() external onlyOwner {
        withdrawalsActive = true;
    }

    function pauseWithdrawals() external onlyOwner {
        withdrawalsActive = false;
    }
}