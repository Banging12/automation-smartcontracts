import hre from 'hardhat'
import { BytesLike, utils } from 'ethers'
import { expect } from 'chai'
import { getMultiplyParams } from '@oasisdex/multiply'
import BigNumber from 'bignumber.js'
import {
    encodeTriggerData,
    forgeUnoswapCalldata,
    getEvents,
    HardhatUtils,
    ONE_INCH_V4_ROUTER,
    toRatio,
} from '../scripts/common'
import { DeployedSystem, deploySystem } from '../scripts/common/deploy-system'
import { DsProxyLike, MPALike } from '../typechain'
import { TriggerGroupType, TriggerType } from '@oasisdex/automation'

const testCdpId = parseInt(process.env.CDP_ID || '13288')
const maxGweiPrice = 1000

describe('BasicBuyCommand', () => {
    const ethAIlk = utils.formatBytes32String('ETH-A')
    const hardhatUtils = new HardhatUtils(hre)

    let system: DeployedSystem
    let MPAInstance: MPALike
    let usersProxy: DsProxyLike
    let proxyOwnerAddress: string
    let receiverAddress: string
    let executorAddress: string
    let snapshotId: string

    const createTrigger = async (triggerData: BytesLike, triggerType: TriggerType, continuous: boolean) => {
        const data = system.automationBot.interface.encodeFunctionData('addTriggers', [
            TriggerGroupType.SingleTrigger,
            [continuous],
            [0],
            [triggerData],
            [triggerType],
        ])
        const signer = await hardhatUtils.impersonate(proxyOwnerAddress)
        return usersProxy.connect(signer).execute(system.automationBot.address, data)
    }

    before(async () => {
        executorAddress = await hre.ethers.provider.getSigner(0).getAddress()
        receiverAddress = await hre.ethers.provider.getSigner(1).getAddress()

        MPAInstance = await hre.ethers.getContractAt('MPALike', hardhatUtils.addresses.MULTIPLY_PROXY_ACTIONS)

        system = await deploySystem({ utils: hardhatUtils, addCommands: true })

        await system.mcdView.approve(executorAddress, true)

        const cdpManager = await hre.ethers.getContractAt('ManagerLike', hardhatUtils.addresses.CDP_MANAGER)
        const proxyAddress = await cdpManager.owns(testCdpId)
        usersProxy = await hre.ethers.getContractAt('DsProxyLike', proxyAddress)
        proxyOwnerAddress = await usersProxy.owner()

        const osmMom = await hre.ethers.getContractAt('OsmMomLike', hardhatUtils.addresses.OSM_MOM)
        const osm = await hre.ethers.getContractAt('OsmLike', await osmMom.osms(ethAIlk))
        await hardhatUtils.setBudInOSM(osm.address, system.mcdView.address)
    })

    beforeEach(async () => {
        snapshotId = await hre.ethers.provider.send('evm_snapshot', [])
    })

    afterEach(async () => {
        await hre.ethers.provider.send('evm_revert', [snapshotId])
    })

    describe('isTriggerDataValid', () => {
        it('should fail if target coll ratio is higher than execution ratio', async () => {
            const [executionRatio, targetRatio] = [toRatio(1.51), toRatio(1.52)]
            const triggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicBuy,
                executionRatio,
                targetRatio,
                0,
                0,
                maxGweiPrice,
            )
            await expect(createTrigger(triggerData, TriggerType.BasicBuy, false)).to.be.reverted
        })

        it('should fail if target target coll ratio is lte liquidation ratio', async () => {
            const [executionRatio, targetRatio] = [toRatio(1.51), toRatio(1.45)]
            const triggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicBuy,
                executionRatio,
                targetRatio,
                0,
                0,
                maxGweiPrice,
            )
            await expect(createTrigger(triggerData, TriggerType.BasicBuy, false)).to.be.reverted
        })

        it('should fail if cdp is not encoded correctly', async () => {
            const [executionRatio, targetRatio] = [toRatio(1.52), toRatio(1.51)]
            const triggerData = encodeTriggerData(
                testCdpId + 1,
                TriggerType.BasicBuy,
                executionRatio,
                targetRatio,
                0,
                0,
                maxGweiPrice,
            )
            await expect(createTrigger(triggerData, TriggerType.BasicBuy, false)).to.be.reverted
        })

        it.skip('should fail if trigger type is not encoded correctly', async () => {
            //NOT relevant anymore as theres is no triggerType to compare to, command is chosen based on triggerType in triggerData
            const [executionRatio, targetRatio] = [toRatio(1.52), toRatio(1.51)]
            const triggerData = utils.defaultAbiCoder.encode(
                ['uint256', 'uint16', 'uint256', 'uint256', 'uint256', 'bool'],
                [testCdpId, TriggerType.StopLossToCollateral, executionRatio, targetRatio, 0, false],
            )
            await expect(createTrigger(triggerData, TriggerType.BasicBuy, false)).to.be.reverted
        })

        it('should fail if deviation is less the minimum', async () => {
            const [executionRatio, targetRatio] = [toRatio(1.52), toRatio(1.51)]
            const triggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicBuy,
                executionRatio,
                targetRatio,
                0,
                0,
                maxGweiPrice,
            )
            await expect(createTrigger(triggerData, TriggerType.BasicBuy, false)).to.be.reverted
        })

        it('should successfully create the trigger', async () => {
            const [executionRatio, targetRatio] = [toRatio(1.52), toRatio(1.51)]
            const triggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicBuy,
                executionRatio,
                targetRatio,
                0,
                50,
                maxGweiPrice,
            )
            const tx = createTrigger(triggerData, TriggerType.BasicBuy, false)
            await expect(tx).not.to.be.reverted
            const receipt = await (await tx).wait()
            const [event] = getEvents(receipt, system.automationBot.interface.getEvent('TriggerAdded'))
            expect(event.args.triggerData).to.eq(triggerData)
        })
    })

    describe('execute', () => {
        async function createTriggerForExecution(
            executionRatio: BigNumber.Value,
            targetRatio: BigNumber.Value,
            continuous: boolean,
        ) {
            const triggerData = encodeTriggerData(
                testCdpId,
                TriggerType.BasicBuy,
                new BigNumber(executionRatio).toFixed(),
                new BigNumber(targetRatio).toFixed(),
                new BigNumber(5000).shiftedBy(18).toFixed(),
                50,
                maxGweiPrice,
            )
            const createTriggerTx = await createTrigger(triggerData, TriggerType.BasicBuy, continuous)
            const receipt = await createTriggerTx.wait()
            const [event] = getEvents(receipt, system.automationBot.interface.getEvent('TriggerAdded'))
            return { triggerId: event.args.triggerId.toNumber(), triggerData }
        }

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
                hardhatUtils.addresses.DAI,
            )
        }

        beforeEach(async () => {
            snapshotId = await hre.ethers.provider.send('evm_snapshot', [])
        })

        afterEach(async () => {
            await hre.ethers.provider.send('evm_revert', [snapshotId])
        })

        it('executes the trigger [ @skip-on-coverage ]', async () => {
            const rawRatio = await system.mcdView.getRatio(testCdpId, true)
            const ratioAtNext = rawRatio.div('10000000000000000').toNumber() / 100
            console.log('ratioAtNext', ratioAtNext)
            const executionRatio = toRatio(ratioAtNext - 0.01)
            const targetRatio = toRatio(ratioAtNext - 0.03)
            const { triggerId, triggerData } = await createTriggerForExecution(executionRatio, targetRatio, false)

            await expect(executeTrigger(triggerId, new BigNumber(targetRatio), triggerData)).not.to.be.reverted
        })

        it('clears the trigger if `continuous` is set to false [ @skip-on-coverage ]', async () => {
            const rawRatio = await system.mcdView.getRatio(testCdpId, true)
            const ratioAtNext = rawRatio.div('10000000000000000').toNumber() / 100
            console.log('ratioAtNext', ratioAtNext)
            const executionRatio = toRatio(ratioAtNext - 0.01)
            const targetRatio = toRatio(ratioAtNext - 0.03)
            const { triggerId, triggerData } = await createTriggerForExecution(executionRatio, targetRatio, false)

            const tx = executeTrigger(triggerId, new BigNumber(targetRatio), triggerData)
            await expect(tx).not.to.be.reverted
            const receipt = await (await tx).wait()
            const finalTriggerRecord = await system.automationBotStorage.activeTriggers(triggerId)
            const addEvents = getEvents(receipt, system.automationBot.interface.getEvent('TriggerAdded'))
            expect(addEvents.length).to.eq(0)
            const removeEvents = getEvents(receipt, system.automationBot.interface.getEvent('TriggerRemoved'))
            const executeEvents = getEvents(receipt, system.automationBot.interface.getEvent('TriggerExecuted'))
            expect(executeEvents.length).to.eq(1)
            expect(removeEvents.length).to.eq(1)
            expect(finalTriggerRecord.triggerHash).to.eq(
                '0x0000000000000000000000000000000000000000000000000000000000000000',
            )
            expect(finalTriggerRecord.continuous).to.eq(false)
        })

        it('keeps the trigger if `continuous` is set to true [ @skip-on-coverage ]', async () => {
            const rawRatio = await system.mcdView.getRatio(testCdpId, true)
            const ratioAtNext = rawRatio.div('10000000000000000').toNumber() / 100
            console.log('ratioAtNext', ratioAtNext)
            const executionRatio = toRatio(ratioAtNext - 0.01)
            const targetRatio = toRatio(ratioAtNext - 0.03)
            const { triggerId, triggerData } = await createTriggerForExecution(executionRatio, targetRatio, true)

            const startingTriggerRecord = await system.automationBotStorage.activeTriggers(triggerId)
            const tx = executeTrigger(triggerId, new BigNumber(targetRatio), triggerData)
            await expect(tx).not.to.be.reverted
            const receipt = await (await tx).wait()

            const triggerHash = hre.ethers.utils.solidityKeccak256(
                ['bytes', 'address', 'address'],
                [triggerData, system.serviceRegistry.address, system.basicBuy?.address],
            )
            const events = getEvents(receipt, system.automationBot.interface.getEvent('TriggerAdded'))
            expect(events.length).to.eq(0)
            const finalTriggerRecord = await system.automationBotStorage.activeTriggers(triggerId)
            expect(finalTriggerRecord.triggerHash).to.eq(triggerHash)
            expect(finalTriggerRecord.continuous).to.eq(true)
            expect(finalTriggerRecord).to.deep.eq(startingTriggerRecord)
        })
    })
})
