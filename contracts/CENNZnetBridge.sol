// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";

// Proof of a witnessed event by CENNZnet validators
struct CENNZnetEventProof {
    // The Id (nonce) of the event
    uint256 eventId;
    // The validator set Id which witnessed the event
    uint32 validatorSetId;
    // v,r,s are sparse arrays expected to align w public key in 'validators'
    // i.e. v[i], r[i], s[i] matches the i-th validator[i]
    // v part of validator signatures
    uint8[] v;
    // r part of validator signatures
    bytes32[] r;
    // s part of validator signatures
    bytes32[] s;
}

// Provides methods for verifying messages from the CENNZnet validator set
contract CENNZnetBridge is Ownable {
    // map from validator set nonce to validator ECDSA addresses (i.e bridge session keys)
    // these should be in sorted order matching `pallet_session::Module<T>::validators()`
    // signatures from a threshold of these addresses are considered approved by the CENNZnet protocol
    mapping(uint => address[]) public validators;
    // Nonce for validator set changes
    uint32 public activeValidatorSetId;
    // Message nonces.
    // CENNZnet will only validate one message per nonce.
    // Claiming out of order is ok.
    mapping(uint => bool) public eventIds;
    // Fee for CENNZnet message verification
    // Offsets bridge upkeep costs i.e updating the validator set
    uint public verificationFee = 1e15;
    // Acceptance threshold in %
    uint public THRESHOLD = 61;

    event SetValidators(address[], uint reward);

    /// force set the active CENNZnet validator set
    function forceSetValidators(address[] memory _validators, uint32 validatorSetId) external onlyOwner {
        require(activeValidatorSetId <= validatorSetId, "cannot change historical validator set");
        validators[validatorSetId] = _validators;
        activeValidatorSetId = validatorSetId;
    }

    // Verify a message was authorised by CENNZnet validators.
    // Callable by anyone.
    // Caller must provide `verificationFee`.
    // Requires signatures from a threshold of current CENNZnet validators.
    // Halts on failure
    //
    // Parameters:
    // - message: the unhashed message data packed wide w validatorSetId & eventId e.g. `abi.encode(arg0, arg2, validatorSetId, eventId);`
    // - proof: Signed witness material generated by CENNZnet proving 'message'
    function verifyMessage(bytes memory message, CENNZnetEventProof memory proof) payable external {
        uint256 eventId = proof.eventId;
        require(!eventIds[eventId], "eventId replayed");
        require(msg.value >= verificationFee || msg.sender == address(this), "must supply verification fee");
        uint32 validatorSetId = proof.validatorSetId;

        bytes32 digest = keccak256(message);
        uint acceptanceTreshold = (validators[validatorSetId].length * THRESHOLD / 100);
        uint witnessCount;
        bytes32 ommited;

        for (uint i; i < validators[validatorSetId].length; i++) {
            // check signature omitted == bytes32(0)
            if(proof.r[i] != ommited) {
                // check signature
                require(validators[validatorSetId][i] == ecrecover(digest, proof.v[i], proof.r[i], proof.s[i]), "signature invalid");
                witnessCount += 1;
                // have we got proven consensus?
                if(witnessCount >= acceptanceTreshold) {
                    break;
                }
            }
        }

        require(witnessCount >= acceptanceTreshold, "not enough signatures");
        eventIds[eventId] = true;
    }

    // Update the known CENNZnet validator set
    //
    // Requires signatures from a threshold of current CENNZnet validators
    // v,r,s are sparse arrays expected to align w addresses / public key in 'validators'
    // i.e. v[i], r[i], s[i] matches the i-th validator[i]
    // ~6,737,588 gas
    function setValidators(
        address[] memory newValidators,
        CENNZnetEventProof memory proof
    ) external {
        require(proof.validatorSetId > activeValidatorSetId, "validator set id replayed");

        bytes memory message = abi.encodePacked(newValidators, proof.validatorSetId, proof.eventId);
        this.verifyMessage(message, proof);

        // update
        validators[proof.validatorSetId] = newValidators;
        activeValidatorSetId = proof.validatorSetId;

        // return any accumlated fees to the sender as a reward
        uint reward = address(this).balance;
        payable(msg.sender).transfer(reward);

        emit SetValidators(newValidators, reward);
    }
}
