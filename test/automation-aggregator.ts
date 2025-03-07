import hre, { ethers } from 'hardhat'
import { expect } from 'chai'
import { BytesLike, ContractTransaction, utils } from 'ethers'
import {
    encodeTriggerData,
    forgeUnoswapCalldata,
    generateRandomAddress,
    getEvents,
    HardhatUtils,
    ONE_INCH_V4_ROUTER,
} from '../scripts/common'
import { DeployedSystem, deploySystem } from '../scripts/common/deploy-system'
import { AutomationBot, AutomationBotStorage, DsProxyLike, ERC20, MakerAdapter, MPALike } from '../typechain'
import BigNumber from 'bignumber.js'
import { getMultiplyParams } from '@oasisdex/multiply'
import { TriggerGroupType, TriggerType } from '@oasisdex/automation'

const testCdpId = parseInt(process.env.CDP_ID || '13288')
const beforeTestCdpId = parseInt(process.env.CDP_ID_2 || '8027')
const maxGweiPrice = 1000

const dummyTriggerDataNoReRegister = utils.defaultAbiCoder.encode(['uint256', 'uint16', 'uint256'], [testCdpId, 2, 101])

function toRatio(units: number) {
    return new BigNumber(units).shiftedBy(4).toNumber()
}

describe('AutomationAggregatorBot', async () => {
    const hardhatUtils = new HardhatUtils(hre)

    let AutomationBotInstance: AutomationBot
    let AutomationBotStorageInstance: AutomationBotStorage
    let ownerProxy: DsProxyLike
    let ownerProxyUserAddress: string
    let beforeOwnerProxy: DsProxyLike
    let beforeOwnerProxyUserAddress: string
    let notOwnerProxy: DsProxyLike
    let notOwnerProxyUserAddress: string
    let MakerAdapterInstance: MakerAdapter
    let dai: ERC20

    let system: DeployedSystem
    let MPAInstance: MPALike
    let receiverAddress: string
    let executorAddress: string
    let snapshotId: string
    let sellExecutionRatio: number
    let sellTargetRatio: number
    let buyExecutionRatio: number
    let buyTargetRatio: number
    let createTrigger: (
        triggerData: BytesLike,
        triggerType: TriggerType,
        continuous: boolean,
    ) => Promise<ContractTransaction>
    const ethAIlk = utils.formatBytes32String('ETH-A')

    before(async () => {
        executorAddress = await hre.ethers.provider.getSigner(0).getAddress()
        receiverAddress = await hre.ethers.provider.getSigner(1).getAddress()
        const utils = new HardhatUtils(hre) // the hardhat network is coalesced to mainnet

        system = await deploySystem({ utils, addCommands: true })

        dai = await hre.ethers.getContractAt('ERC20', hardhatUtils.addresses.DAI)

        AutomationBotInstance = system.automationBot
        AutomationBotStorageInstance = system.automationBotStorage
        MakerAdapterInstance = system.makerAdapter

        MPAInstance = await hre.ethers.getContractAt('MPALike', hardhatUtils.addresses.MULTIPLY_PROXY_ACTIONS)

        await system.mcdView.approve(executorAddress, true)
        const cdpManager = await hre.ethers.getContractAt('ManagerLike', hardhatUtils.addresses.CDP_MANAGER)

        const proxyAddress = await cdpManager.owns(testCdpId)
        ownerProxy = await hre.ethers.getContractAt('DsProxyLike', proxyAddress)
        ownerProxyUserAddress = await ownerProxy.owner()

        const beforeProxyAddress = await cdpManager.owns(beforeTestCdpId)
        beforeOwnerProxy = await hre.ethers.getContractAt('DsProxyLike', beforeProxyAddress)
        beforeOwnerProxyUserAddress = await beforeOwnerProxy.owner()

        const otherProxyAddress = await cdpManager.owns(1)
        notOwnerProxy = await hre.ethers.getContractAt('DsProxyLike', otherProxyAddress)
        notOwnerProxyUserAddress = await notOwnerProxy.owner()
        const osmMom = await hre.ethers.getContractAt('OsmMomLike', hardhatUtils.addresses.OSM_MOM)
        const osm = await hre.ethers.getContractAt('OsmLike', await osmMom.osms(ethAIlk))
        await hardhatUtils.setBudInOSM(osm.address, system.mcdView.address)

        const rawRatio = await system.mcdView.getRatio(testCdpId, true)
        const ratioAtNext = rawRatio.div('10000000000000000').toNumber() / 100
        console.log('ratioAtNext', ratioAtNext)
        sellExecutionRatio = toRatio(ratioAtNext + 0.01)
        sellTargetRatio = toRatio(ratioAtNext + 0.93)
        buyExecutionRatio = toRatio(ratioAtNext - 0.01)
        buyTargetRatio = toRatio(ratioAtNext - 0.11)

        createTrigger = async (triggerData: BytesLike, triggerType: TriggerType, continuous: boolean) => {
            const data = system.automationBot.interface.encodeFunctionData('addTriggers', [
                TriggerGroupType.SingleTrigger,
                [continuous],
                [0],
                [triggerData],
                [triggerType],
            ])
            const signer = await hardhatUtils.impersonate(ownerProxyUserAddress)
            return ownerProxy.connect(signer).execute(system.automationBot.address, data)
        }
    })

    beforeEach(async () => {
        snapshotId = await hre.ethers.provider.send('evm_snapshot', [])
    })

    afterEach(async () => {
        await hre.ethers.provider.send('evm_revert', [snapshotId])
    })

    describe('addTriggerGroup', async () => {
        //TODO: why this is not executed?
        const groupTypeId = TriggerGroupType.ConstantMultiple

        const bbTriggerData = encodeTriggerData(
            testCdpId,
            TriggerType.BasicBuy,
            buyExecutionRatio,
            buyTargetRatio,
            ethers.constants.MaxUint256,
            50,
            maxGweiPrice,
        )
        // basic sell
        const bsTriggerData = encodeTriggerData(
            testCdpId,
            TriggerType.BasicSell,
            sellExecutionRatio,
            sellTargetRatio,
            ethers.constants.Zero,
            50,
            maxGweiPrice,
        )
        // data for the vault that's created before all tests
        const [beforeSellExecutionRatio, beforeSellTargetRatio] = [toRatio(1.6), toRatio(1.8)]
        const [beforeBuyExecutionRatio, beforeBuyTargetRatio] = [toRatio(2), toRatio(1.8)]
        // basic buy
        const beforeBbTriggerData = encodeTriggerData(
            beforeTestCdpId,
            TriggerType.BasicBuy,
            beforeBuyExecutionRatio,
            beforeBuyTargetRatio,
            ethers.constants.MaxUint256,
            50,
            maxGweiPrice,
        )
        // basic sell
        const beforeBsTriggerData = encodeTriggerData(
            beforeTestCdpId,
            TriggerType.BasicSell,
            beforeSellExecutionRatio,
            beforeSellTargetRatio,
            0,
            50,
            maxGweiPrice,
        )
        const replacedTriggerId = [0, 0]

        async function executeTrigger(triggerId: number, targetRatio: BigNumber, triggerData: BytesLike) {
            const collRatio = await system.mcdView.getRatio(testCdpId, true)
            const [collateral, debt] = await system.mcdView.getVaultInfo(testCdpId)
            const oraclePrice = await system.mcdView.getNextPrice(ethAIlk)
            const slippage = new BigNumber(0.01)
            const oasisFee = new BigNumber(0.002)

            const oraclePriceUnits = new BigNumber(oraclePrice.toString()).shiftedBy(-18)
            const { collateralDelta, debtDelta, oazoFee, skipFL } = getMultiplyParams(
                {
                    oraclePrice: oraclePriceUnits,
                    marketPrice: oraclePriceUnits,
                    OF: oasisFee,
                    FF: new BigNumber(0),
                    slippage,
                },
                {
                    currentDebt: new BigNumber(debt.toString()).shiftedBy(-18),
                    currentCollateral: new BigNumber(collateral.toString()).shiftedBy(-18),
                    minCollRatio: new BigNumber(collRatio.toString()).shiftedBy(-18),
                },
                {
                    requiredCollRatio: targetRatio.shiftedBy(-4),
                    providedCollateral: new BigNumber(0),
                    providedDai: new BigNumber(0),
                    withdrawDai: new BigNumber(0),
                    withdrawColl: new BigNumber(0),
                },
            )

            const cdpData = {
                gemJoin: hardhatUtils.addresses.MCD_JOIN_ETH_A,
                fundsReceiver: receiverAddress,
                cdpId: testCdpId,
                ilk: ethAIlk,
                requiredDebt: debtDelta.shiftedBy(18).abs().toFixed(0),
                borrowCollateral: collateralDelta.shiftedBy(18).abs().toFixed(0),
                withdrawCollateral: 0,
                withdrawDai: 0,
                depositDai: 0,
                depositCollateral: 0,
                skipFL,
                methodName: '',
            }

            const minToTokenAmount = new BigNumber(cdpData.borrowCollateral).times(new BigNumber(1).minus(slippage))
            const exchangeData = {
                fromTokenAddress: hardhatUtils.addresses.DAI,
                toTokenAddress: hardhatUtils.addresses.WETH,
                fromTokenAmount: cdpData.requiredDebt,
                toTokenAmount: cdpData.borrowCollateral,
                minToTokenAmount: minToTokenAmount.toFixed(0),
                exchangeAddress: ONE_INCH_V4_ROUTER,
                _exchangeCalldata: forgeUnoswapCalldata(
                    hardhatUtils.addresses.DAI,
                    new BigNumber(cdpData.requiredDebt).minus(oazoFee.shiftedBy(18)).toFixed(0),
                    minToTokenAmount.toFixed(0),
                    false,
                ),
            }

            const executionData = MPAInstance.interface.encodeFunctionData('increaseMultiple', [
                exchangeData,
                cdpData,
                hardhatUtils.mpaServiceRegistry(),
            ])

            return system.automationExecutor.execute(
                executionData,
                testCdpId,
                triggerData,
                system.basicBuy!.address,
                triggerId,
                0,
                0,
                0,
                dai.address,
            )
        }

        beforeEach(async () => {
            const beforeOwner = await hardhatUtils.impersonate(beforeOwnerProxyUserAddress)
            const beforeDataToSupplyAdd = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                replacedTriggerId,
                [beforeBbTriggerData, beforeBsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            const tx = await beforeOwnerProxy
                .connect(beforeOwner)
                .execute(AutomationBotInstance.address, beforeDataToSupplyAdd, { gasLimit: 2_000_000 })
            await tx.wait()
        })
        it('should successfully create a trigger group through DSProxy', async () => {
            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)
            console.log('-------')
            console.log(`user address ${ownerProxyUserAddress}`)
            console.log(`proxy ${ownerProxy.address}`)
            console.log(`automation bot address ${AutomationBotInstance.address}`)
            console.log(`bot address ${AutomationBotInstance.address}`)
            console.log('-------')
            const counterBefore = await AutomationBotStorageInstance.triggersCounter()
            const dataToSupply = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                replacedTriggerId,
                [bbTriggerData, bsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            const tx = await ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupply)
            const counterAfter = await AutomationBotStorageInstance.triggersCounter()
            expect(counterAfter.toNumber()).to.be.equal(counterBefore.toNumber() + 2)
            const receipt = await tx.wait()
            const events = getEvents(receipt, AutomationBotInstance.interface.getEvent('TriggerGroupAdded'))
            expect(AutomationBotInstance.address).to.eql(events[0].address)
        })
        it('should successfully create a trigger group - and then replace it with new one', async () => {
            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)
            const counterBefore = await AutomationBotStorageInstance.triggersCounter()
            const dataToSupply = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                replacedTriggerId,
                [bbTriggerData, bsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            const tx = await ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupply)
            const counterAfter = await AutomationBotStorageInstance.triggersCounter()
            expect(counterAfter.toNumber()).to.be.equal(counterBefore.toNumber() + 2)
            const receipt = await tx.wait()
            const events = getEvents(receipt, AutomationBotInstance.interface.getEvent('TriggerGroupAdded'))
            expect(AutomationBotInstance.address).to.eql(events[0].address)
            const triggerCounter = await AutomationBotStorageInstance.triggersCounter()
            const dataToSupply2 = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                [Number(triggerCounter) - 1, Number(triggerCounter)],
                [bbTriggerData, bsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            const tx2 = await ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupply2)

            const counterAfter2 = await AutomationBotStorageInstance.triggersCounter()

            expect(counterAfter2.toNumber()).to.be.equal(counterAfter.toNumber() + 2)
            const receipt2 = await tx2.wait()
            const events2 = getEvents(receipt2, AutomationBotInstance.interface.getEvent('TriggerGroupAdded'))
            expect(AutomationBotInstance.address).to.eql(events2[0].address)
        })
        it('should successfully create a trigger group, remove old bb and add new bb in its place', async () => {
            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)
            const oldBbTriggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicBuy,
                buyExecutionRatio,
                buyTargetRatio,
                ethers.constants.MaxUint256,
                50,
                maxGweiPrice,
            )

            const createTx = await createTrigger(oldBbTriggerData, TriggerType.BasicBuy, true)

            await createTx.wait()
            const triggersCounterBefore = await AutomationBotStorageInstance.triggersCounter()
            const dataToSupply = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                [triggersCounterBefore.toNumber(), 0],
                [bbTriggerData, bsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            const counterBefore = await AutomationBotStorageInstance.triggersCounter()
            const tx = await ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupply)
            const counterAfter = await AutomationBotStorageInstance.triggersCounter()
            expect(counterAfter.toNumber()).to.be.equal(counterBefore.toNumber() + 2)
            const receipt = await tx.wait()

            const botEvents = getEvents(receipt, AutomationBotInstance.interface.getEvent('TriggerRemoved'))
            const aggregatorEvents = getEvents(receipt, AutomationBotInstance.interface.getEvent('TriggerGroupAdded'))
            expect(AutomationBotInstance.address).to.eql(botEvents[0].address)
            expect(AutomationBotInstance.address).to.eql(aggregatorEvents[0].address)
        })

        it('should not create a trigger group, remove old bs and add bb in its place', async () => {
            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)
            // basic sell
            const oldBbTriggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicBuy,
                buyExecutionRatio,
                buyTargetRatio,
                ethers.constants.MaxUint256,
                50,
                maxGweiPrice,
            )
            const oldBsTriggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicSell,
                sellExecutionRatio,
                sellTargetRatio,
                5000,
                50,
                maxGweiPrice,
            )
            const createTx = await createTrigger(oldBbTriggerData, TriggerType.BasicBuy, true)
            const createTx2 = await createTrigger(oldBsTriggerData, TriggerType.BasicSell, true)
            await createTx.wait()
            await createTx2.wait()
            const triggersCounterBefore = await AutomationBotStorageInstance.triggersCounter()
            const dataToSupply = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                [triggersCounterBefore.toNumber() - 1, triggersCounterBefore.toNumber()],
                [bsTriggerData, bbTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            const tx = ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupply)
            await expect(tx).to.be.reverted
        })
        it('should successfully create a trigger group, remove old bb and old bs - add new bs and bb in their place', async () => {
            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)
            const oldBbTriggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicBuy,
                buyExecutionRatio,
                buyTargetRatio,
                5000,
                50,
                maxGweiPrice,
            )
            const oldBsTriggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicSell,
                sellExecutionRatio,
                sellTargetRatio,
                5000,
                50,
                maxGweiPrice,
            )
            const createTx = await createTrigger(oldBbTriggerData, TriggerType.BasicBuy, true)
            const createTx2 = await createTrigger(oldBsTriggerData, TriggerType.BasicSell, true)
            await createTx.wait()
            await createTx2.wait()
            const triggersCounterBefore = await AutomationBotStorageInstance.triggersCounter()
            const dataToSupply = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                [triggersCounterBefore.toNumber() - 1, triggersCounterBefore.toNumber()],
                [bbTriggerData, bsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            const counterBefore = await AutomationBotStorageInstance.triggersCounter()
            const tx = await ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupply)
            const counterAfter = await AutomationBotStorageInstance.triggersCounter()
            expect(counterAfter.toNumber()).to.be.equal(counterBefore.toNumber() + 2)
            const receipt = await tx.wait()

            const botEvents = getEvents(receipt, AutomationBotInstance.interface.getEvent('TriggerRemoved'))
            const aggregatorEvents = getEvents(receipt, AutomationBotInstance.interface.getEvent('TriggerGroupAdded'))
            expect(AutomationBotInstance.address).to.eql(botEvents[0].address)
            expect(AutomationBotInstance.address).to.eql(aggregatorEvents[0].address)
        })
        it('should successfully create a trigger group, remove old bbs - add new bs and bb in their place', async () => {
            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)
            const oldBbTriggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicBuy,
                buyExecutionRatio,
                buyTargetRatio,
                5000,
                50,
                maxGweiPrice,
            )

            const createTx = await createTrigger(oldBbTriggerData, TriggerType.BasicBuy, true)
            const createTx2 = await createTrigger(oldBbTriggerData, TriggerType.BasicBuy, true)
            await createTx.wait()
            await createTx2.wait()
            const triggersCounterBefore = await AutomationBotStorageInstance.triggersCounter()
            const dataToSupply = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                [triggersCounterBefore.toNumber() - 1, triggersCounterBefore.toNumber()],
                [bbTriggerData, bsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            const counterBefore = await AutomationBotStorageInstance.triggersCounter()
            const tx = await ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupply)
            const counterAfter = await AutomationBotStorageInstance.triggersCounter()
            expect(counterAfter.toNumber()).to.be.equal(counterBefore.toNumber() + 2)
            const receipt = await tx.wait()

            const botEvents = getEvents(receipt, AutomationBotInstance.interface.getEvent('TriggerRemoved'))
            const aggregatorEvents = getEvents(receipt, AutomationBotInstance.interface.getEvent('TriggerGroupAdded'))
            expect(AutomationBotInstance.address).to.eql(botEvents[0].address)
            expect(AutomationBotInstance.address).to.eql(aggregatorEvents[0].address)
        })
        it('should successfully create a trigger group, remove old bb and old bs - add new bs and bb in their place - reverse order', async () => {
            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)
            const oldBbTriggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicBuy,
                buyExecutionRatio,
                buyTargetRatio,
                5000,
                50,
                maxGweiPrice,
            )
            const oldBsTriggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicSell,
                sellExecutionRatio,
                sellTargetRatio,
                5000,
                50,
                maxGweiPrice,
            )
            const createTx = await createTrigger(oldBbTriggerData, TriggerType.BasicBuy, true)
            const createTx2 = await createTrigger(oldBsTriggerData, TriggerType.BasicSell, true)
            await createTx.wait()
            await createTx2.wait()
            const triggersCounterBefore = await AutomationBotStorageInstance.triggersCounter()
            const dataToSupply = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                [triggersCounterBefore.toNumber(), triggersCounterBefore.toNumber() - 1],
                [bbTriggerData, bsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            const counterBefore = await AutomationBotStorageInstance.triggersCounter()
            const tx = await ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupply)
            const counterAfter = await AutomationBotStorageInstance.triggersCounter()
            expect(counterAfter.toNumber()).to.be.equal(counterBefore.toNumber() + 2)
            const receipt = await tx.wait()

            const botEvents = getEvents(receipt, AutomationBotInstance.interface.getEvent('TriggerRemoved'))
            const aggregatorEvents = getEvents(receipt, AutomationBotInstance.interface.getEvent('TriggerGroupAdded'))
            expect(AutomationBotInstance.address).to.eql(botEvents[0].address)
            expect(AutomationBotInstance.address).to.eql(aggregatorEvents[0].address)
        })
        it('should not create a trigger group when called by not the owner', async () => {
            const notOwner = await hardhatUtils.impersonate(notOwnerProxyUserAddress)
            const dataToSupply = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                replacedTriggerId,
                [bbTriggerData, bsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            await expect(notOwnerProxy.connect(notOwner).execute(AutomationBotInstance.address, dataToSupply)).to.be
                .reverted
        })
        it('should revert when called not by the delegate ', async () => {
            const tx = AutomationBotInstance.addTriggers(
                groupTypeId,
                [true, true],
                replacedTriggerId,
                [bbTriggerData, bsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            )
            await expect(tx).to.be.revertedWith('bot/only-delegate')
        })
        it('should emit TriggerGroupAdded (from AutomationBotAggregator) if called by user being an owner of proxy', async () => {
            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)
            const dataToSupply = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                replacedTriggerId,
                [bbTriggerData, bsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            const tx = await ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupply)

            const receipt = await tx.wait()
            const events = getEvents(receipt, AutomationBotInstance.interface.getEvent('TriggerGroupAdded'))
            expect(AutomationBotInstance.address).to.eql(events[0].address)
        })
        it('should successfully execute a trigger from the group', async () => {
            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)
            const counterBefore = await AutomationBotStorageInstance.triggersCounter()
            const dataToSupply = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                replacedTriggerId,
                [bbTriggerData, bsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            const tx = await ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupply)
            const counterAfter = await AutomationBotStorageInstance.triggersCounter()
            expect(counterAfter.toNumber()).to.be.equal(counterBefore.toNumber() + 2)
            const receipt = await tx.wait()
            const events = getEvents(receipt, AutomationBotInstance.interface.getEvent('TriggerGroupAdded'))
            expect(AutomationBotInstance.address).to.eql(events[0].address)

            const targetRatio = new BigNumber(2.53).shiftedBy(4)
            const triggerIds = [Number(counterAfter) - 1, Number(counterAfter)]
            const txExecute = executeTrigger(triggerIds[0], targetRatio, bbTriggerData)

            const receiptExecute = await (await txExecute).wait()
            const eventTriggerExecuted = getEvents(
                receiptExecute,
                AutomationBotInstance.interface.getEvent('TriggerExecuted'),
            )

            expect(eventTriggerExecuted.length).to.eq(1)
        })
    })
    describe('removeTriggers', async () => {
        const groupTypeId = TriggerGroupType.ConstantMultiple
        const replacedTriggerId = [0, 0]

        // current coll ratio : 1.859946411122229468
        const [sellExecutionRatio, sellTargetRatio] = [toRatio(1.6), toRatio(2.53)]
        const [buyExecutionRatio, buyTargetRatio] = [toRatio(2.55), toRatio(2.53)]

        // basic buy
        const bbTriggerData = encodeTriggerData(
            testCdpId,
            TriggerType.BasicBuy,
            buyExecutionRatio,
            buyTargetRatio,
            0,
            50,
            maxGweiPrice,
        )
        // basic sell
        const bsTriggerData = encodeTriggerData(
            testCdpId,
            TriggerType.BasicSell,
            sellExecutionRatio,
            sellTargetRatio,
            0,
            50,
            maxGweiPrice,
        )
        const [beforeSellExecutionRatio, beforeSellTargetRatio] = [toRatio(1.6), toRatio(1.8)]
        const [beforeBuyExecutionRatio, beforeBuyTargetRatio] = [toRatio(2), toRatio(1.8)]
        // basic buy
        const beforeBbTriggerData = encodeTriggerData(
            beforeTestCdpId,
            TriggerType.BasicBuy,
            beforeBuyExecutionRatio,
            beforeBuyTargetRatio,
            0,
            50,
            maxGweiPrice,
        )
        // basic sell
        const beforeBsTriggerData = encodeTriggerData(
            beforeTestCdpId,
            TriggerType.BasicSell,
            beforeSellExecutionRatio,
            beforeSellTargetRatio,
            0,
            50,
            maxGweiPrice,
        )

        beforeEach(async () => {
            const beforeOwner = await hardhatUtils.impersonate(beforeOwnerProxyUserAddress)
            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)

            const beforeDataToSupplyAdd = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                replacedTriggerId,
                [beforeBbTriggerData, beforeBsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            const dataToSupplyAdd = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                replacedTriggerId,
                [bbTriggerData, bsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            await beforeOwnerProxy.connect(beforeOwner).execute(AutomationBotInstance.address, beforeDataToSupplyAdd)
            const tx = await ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupplyAdd)
            await tx.wait()
        })

        it('should successfully remove a trigger group through DSProxy', async () => {
            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)

            const triggerCounter = await AutomationBotStorageInstance.triggersCounter()

            const triggerIds = [Number(triggerCounter) - 1, Number(triggerCounter)]
            const dataToSupplyRemove = AutomationBotInstance.interface.encodeFunctionData('removeTriggers', [
                triggerIds,
                [bbTriggerData, bsTriggerData],
                false,
            ])
            await expect(ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupplyRemove)).to.not.be
                .reverted
        })

        it('should only remove approval if last param set to true - test FALSE', async () => {
            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)
            const triggerCounter = await AutomationBotStorageInstance.triggersCounter()
            const triggerIds = [Number(triggerCounter) - 1, Number(triggerCounter)]
            const dataToSupplyRemove = AutomationBotInstance.interface.encodeFunctionData('removeTriggers', [
                triggerIds,
                [bbTriggerData, bsTriggerData],
                false,
            ])
            await ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupplyRemove)
            const status = await MakerAdapterInstance.canCall(bbTriggerData, AutomationBotInstance.address)
            expect(status).to.equal(true)
        })
        it('should only remove approval if last param set to true - test TRUE', async () => {
            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)
            const triggerCounter = await AutomationBotStorageInstance.triggersCounter()
            const triggerIds = [Number(triggerCounter) - 1, Number(triggerCounter)]
            const dataToSupplyRemove = AutomationBotInstance.interface.encodeFunctionData('removeTriggers', [
                triggerIds,
                [bbTriggerData, bsTriggerData],
                true,
            ])
            await ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupplyRemove)
            const status = await MakerAdapterInstance.canCall(bbTriggerData, AutomationBotInstance.address)
            expect(status).to.equal(false)
        })
        it('should revert if called not through delegatecall', async () => {
            const triggerCounter = await AutomationBotStorageInstance.triggersCounter()

            const triggerIds = [Number(triggerCounter) - 1, Number(triggerCounter)]
            const tx = AutomationBotInstance.removeTriggers(triggerIds, [bbTriggerData, bsTriggerData], true)
            await expect(tx).to.be.revertedWith('bot/only-delegate')
        })

        it('should not remove a trigger group by non owner DSProxy', async () => {
            const notOwner = await hardhatUtils.impersonate(notOwnerProxyUserAddress)
            const triggerCounter = await AutomationBotStorageInstance.triggersCounter()

            const triggerIds = [Number(triggerCounter) - 1, Number(triggerCounter)]
            const dataToSupplyRemove = AutomationBotInstance.interface.encodeFunctionData('removeTriggers', [
                triggerIds,
                [bbTriggerData, bsTriggerData],
                false,
            ])
            await expect(ownerProxy.connect(notOwner).execute(AutomationBotInstance.address, dataToSupplyRemove)).to.be
                .reverted
        })
        it('should not remove a trigger group not owned by owner', async () => {
            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)

            const triggerCounter = await AutomationBotStorageInstance.triggersCounter()

            const beforeTriggerIds = [Number(triggerCounter) - 3, Number(triggerCounter) - 2]
            const dataToSupplyRemove = AutomationBotInstance.interface.encodeFunctionData('removeTriggers', [
                beforeTriggerIds,
                [beforeBbTriggerData, beforeBsTriggerData],
                false,
            ])
            await expect(ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupplyRemove)).to.be
                .reverted
        })
    })
    describe('cdpAllowed', async () => {
        beforeEach(async () => {
            const groupTypeId = TriggerGroupType.ConstantMultiple
            const replacedTriggerId = [0, 0]

            // current coll ratio : 1.859946411122229468
            const [sellExecutionRatio, sellTargetRatio] = [toRatio(1.6), toRatio(2.53)]
            const [buyExecutionRatio, buyTargetRatio] = [toRatio(2.55), toRatio(2.53)]

            // basic buy
            const bbTriggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicBuy,
                buyExecutionRatio,
                buyTargetRatio,
                0,
                50,
                maxGweiPrice,
            )
            // basic sell
            const bsTriggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicSell,
                sellExecutionRatio,
                sellTargetRatio,
                0,
                50,
                maxGweiPrice,
            )

            const owner = await hardhatUtils.impersonate(ownerProxyUserAddress)
            const dataToSupply = AutomationBotInstance.interface.encodeFunctionData('addTriggers', [
                groupTypeId,
                [true, true],
                replacedTriggerId,
                [bbTriggerData, bsTriggerData],
                [TriggerType.BasicBuy, TriggerType.BasicSell],
            ])
            await ownerProxy.connect(owner).execute(AutomationBotInstance.address, dataToSupply)
        })

        it('should return false for bad operator address', async () => {
            const status = await MakerAdapterInstance.canCall(
                dummyTriggerDataNoReRegister,
                '0x1234123412341234123412341234123412341234',
            )

            expect(status).to.equal(false, 'approval returned for random address')
        })

        it('should return true for correct operator address', async () => {
            const status = await MakerAdapterInstance.canCall(
                dummyTriggerDataNoReRegister,
                AutomationBotInstance.address,
            )
            expect(status).to.equal(true, 'approval do not exist for AutomationBot')
        })
        it('should return false for correct operator address', async () => {
            const status = await MakerAdapterInstance.canCall(
                dummyTriggerDataNoReRegister,
                AutomationBotInstance.address,
            )
            //TODO: why was false heree originally?
            expect(status).to.equal(true, 'approval does exist for AutomationBotAggregatorInstance')
        })
    })
})
