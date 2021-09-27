
const { Api } = require('@cennznet/api');
require("dotenv").config();
const logger = require('./logger');
const { curly } = require("node-libcurl");
const { ethers } = require("hardhat");
let txExecutor;

// Ignore if validator public key is 0x000..
const IGNORE_KEY = '0x000000000000000000000000000000000000000000000000000000000000000000';

// Get the notary key from CENNZnet and convert it to public key to be used to set validator on bridge contract
async function extractNewValidators(api) {
    const notaryKeys = await api.query.ethBridge.notaryKeys();
    const newValidators = notaryKeys.map((notaryKey) => {
        if (notaryKey.toString() === IGNORE_KEY) return notaryKey.toString();
        let decompressedPk = ethers.utils.computePublicKey(notaryKey);
        let h = ethers.utils.keccak256('0x' + decompressedPk.slice(4));
        return '0x' + h.slice(26)
    });
    return newValidators;
}

// Submit the event proof on Ethereum Bridge contract
async function getEventPoofAndSubmit(api, eventId, bridge, txExecutor, newValidatorSetId) {
    try {

        const eventExistsOnEth = await bridge.eventIds(eventId.toString());
        const eventProof = await withTimeout(api.derive.ethBridge.eventProof(eventId), 20000);
        if (eventProof && !eventExistsOnEth) {
            const newValidators = await extractNewValidators(api);
            logger.info(`Sending setValidators tx with the account: ${txExecutor.address}`);
            logger.info(`Parameters :::`);
            logger.info(`newValidators:${newValidators}`);
            logger.info(`newValidatorSetId: ${newValidatorSetId}`);
            logger.info(`event proof::${eventProof}`);
            const gasEstimated = await bridge.estimateGas.setValidators(newValidators, newValidatorSetId, eventProof, {gasLimit: 500000});
            logger.info(JSON.stringify(await bridge.setValidators(newValidators, newValidatorSetId, eventProof, {gasLimit: 500000})));
            const balance = await ethers.provider.getBalance(txExecutor.address);
            logger.info(`Balance is: ${balance}`);
            const gasPrice = await ethers.provider.getGasPrice();
            logger.info(`Gas price: ${gasPrice.toString()}`);
            const gasRequired = gasEstimated.mul(gasPrice);
            logger.info(`Gas required: ${gasRequired.toString()}`);
            if (balance.lt(gasRequired.mul(2))) {
                const {statusCode, data} = await curly.post(`https://hooks.slack.com/services/${process.env.SLACK_SECRET}`, {
                    postFields: JSON.stringify({
                        "text": ` 🚨 To keep the validator relayer running, topup the eth account ${txExecutor.address} on CENNZnets ${process.env.NETWORK} chain`
                    }),
                    httpHeader: [
                        'Content-Type: application/json',
                        'Accept: application/json'
                    ],
                });
                logger.info(`Slack notification sent ${data} and status code ${statusCode}`);
            }
        }
    } catch (e) {
        logger.warn('Something went wrong:');
        logger.error(`Error: ${e}`);
    }
}

async function main (networkName, bridgeContractAddress) {
    networkName = networkName || 'local';

    const api = await Api.create({network: networkName});
    logger.info(`Connect to cennznet network ${networkName}`);
    [txExecutor] = await ethers.getSigners();

    // Get the bridge instance that was deployed
    const Bridge = await ethers.getContractFactory('CENNZnetBridge');
    logger.info('Connecting to CENNZnet bridge contract...');
    const bridge = await Bridge.attach(bridgeContractAddress);
    await bridge.deployed();
    logger.info(`CENNZnet bridge deployed to: ${bridge.address}`);
    logger.info(`Executor: ${txExecutor.address}`);

    // For any kind of restart, we check if the last event proof generated on CENNZnet side, has been update on Eth side
    logger.info('Check the last event proof generated on CENNZnet side, has been update on Eth side');
    const lastEventProofIdFromCennznet = await api.query.ethBridge.notarySetProofId();
    logger.info(`lastEventProofIdFromCennznet: ${lastEventProofIdFromCennznet.toString()}`);
    const eventExistsOnEth = await bridge.eventIds(lastEventProofIdFromCennznet.toString());
    logger.info(`eventExists on Ethereum: ${eventExistsOnEth}`);
    try {
        // check if event proof exist on Eth for last event proof id of CENNZnet
        if (!eventExistsOnEth && lastEventProofIdFromCennznet.toString() !== '0') {
            const eventProof = await withTimeout(api.derive.ethBridge.eventProof(lastEventProofIdFromCennznet), 10000);
            if (eventProof) {
                logger.info('Previous event proof not updated');
                const newValidators = await extractNewValidators(api);
                logger.info(`New validators: ${newValidators}`);
                const gasEstimated = await bridge.estimateGas.setValidators(newValidators, eventProof, {gasLimit: 500000});
                logger.info(`Gas estimate ${gasEstimated}`);
                logger.info(await bridge.setValidators(newValidators, eventProof, {gasLimit: 500000}));
            }
        }
    } catch (e) {
        logger.warn('Something went wrong while setting last event proof generated on CENNZnet side:');
        logger.error(`Error: ${e}`);
    }

    await api.rpc.chain
        .subscribeFinalizedHeads(async (head) => {
           const blockNumber = head.number.toNumber();
           logger.info(`HEALTH CHECK => OK`);
           logger.info(`At blocknumber: ${blockNumber}`);

           const blockHash = head.hash.toString();
           const events = await api.query.system.events.at(blockHash);
           events.map(async ({event}) => {
                const { section, method, data } = event;
                if (section === 'ethBridge' && method === 'AuthoritySetChange') {
                    const dataFetched = data.toHuman();
                    const eventIdFound = dataFetched[0];
                    const newValidatorSetId = dataFetched[1];
                    await getEventPoofAndSubmit(api, eventIdFound, bridge, txExecutor, newValidatorSetId.toString());
                }
            })
        });
}

async function withTimeout(promise, timeoutMs) {
    return Promise.race ([
        promise,
        new Promise  ((resolve) => {
            setTimeout(() => {
                resolve(null);
            }, timeoutMs);
        }),
    ]);
}

const networkName = process.env.NETWORK;
const bridgeContractAddress = process.env.BRIDGE_CONTRACT;
main(networkName, bridgeContractAddress).catch((err) => console.log(err));
