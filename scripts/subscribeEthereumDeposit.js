
const { Api } = require('@cennznet/api');
require("dotenv").config();
const { Keyring } = require('@polkadot/keyring');
const logger = require('./logger');
const { ethers } = require("hardhat");
let txExecutor;

async function sendClaim(claim, transactionHash, api, signer, nonce) {
    return new Promise(  (resolve, reject) => {
        api.tx.erc20Peg.depositClaim(transactionHash, claim).signAndSend(signer, { nonce }, async ({status, events}) => {
            if (status.isInBlock) {
                for (const {event: {method, section, data}} of events) {
                    console.log('\t', `: ${section}.${method}`, data.toString());
                    const [, claimer] = data;
                    if (section === 'erc20Peg' && method == 'Erc20Claim' && claimer && claimer.toString() === signer.address) {
                        const eventClaimId = data[0];
                        console.log('*******************************************');
                        console.log('Deposit claim on CENNZnet side started for claim Id', eventClaimId.toString());
                        resolve(eventClaimId);
                    }
                    else if (section === 'system' && method === 'ExtrinsicFailed') {
                        reject(data);
                    }
                }
            }
        });
    });
}

async function main (networkName, pegContractAddress) {
    networkName = networkName || 'local';

    const api = await Api.create({network: networkName});
    logger.info(`Connect to cennznet network ${networkName}`);
    [txExecutor] = await ethers.getSigners();

    const keyring = new Keyring({type: 'sr25519'});
    const alice = keyring.addFromUri('//Alice');
    console.log('CENNZnet signer address:', alice.address);

    // Get the bridge instance that was deployed
    const Peg = await ethers.getContractFactory('ERC20Peg');
    logger.info('Connecting to CENNZnet peg contract...');
    const peg = await Peg.attach(pegContractAddress);
    await peg.deployed();
    logger.info(`CENNZnet peg deployed to: ${peg.address}`);
    logger.info(`Executor: ${txExecutor.address}`);

    let nonce = (await api.rpc.system.accountNextIndex(alice.address)).toNumber();
    peg.on("Deposit", async (sender, tokenAddress, amount, cennznetAddress, eventInfo) => {
        console.log('Nonce:::', nonce);
        const claim = {
            tokenAddress,
            amount: amount.toString(),
            beneficiary: cennznetAddress
        };
        try {
            const eventId = await sendClaim(claim, eventInfo.transactionHash, api, alice, nonce++);
            console.log(`${eventInfo.transactionHash}:${eventId}`);
        } catch (e) {
            console.log('err:',e);
        }
    });

}


const networkName = process.env.NETWORK;
const pegContractAddress = process.env.PEG_CONTRACT;
console.log('pegContractAddress::',pegContractAddress);
main(networkName, pegContractAddress).catch((err) => console.log(err));
