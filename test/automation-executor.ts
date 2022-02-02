import { ethers } from 'hardhat'
import { expect } from 'chai'
import { AutomationBot, AutomationExecutor, DsProxyLike, DummyCommand, ServiceRegistry } from '../typechain'
import { CDP_MANAGER_ADDRESS, getCommandHash, generateRandomAddress, impersonate, getEvents } from './utils'
import { AutomationServiceName, TriggerType } from './util.types'
import { constants, Signer } from 'ethers'
import { deployMockContract, MockContract } from 'ethereum-waffle'

const testCdpId = parseInt(process.env.CDP_ID || '26125')

describe('AutomationExecutor', async () => {
    let ServiceRegistryInstance: ServiceRegistry
    let AutomationBotInstance: AutomationBot
    let AutomationExecutorInstance: AutomationExecutor
    let DummyCommandInstance: DummyCommand
    let MockERC20Instance: MockContract
    let ExchangeInstance: MockContract
    let proxyOwnerAddress: string
    let usersProxy: DsProxyLike
    let owner: Signer
    let notOwner: Signer
    let snapshotId: string

    before(async () => {
        ;[owner, notOwner] = await ethers.getSigners()

        const serviceRegistryFactory = await ethers.getContractFactory('ServiceRegistry')
        const dummyCommandFactory = await ethers.getContractFactory('DummyCommand')
        const automationBotFactory = await ethers.getContractFactory('AutomationBot')
        const automationExecutorFactory = await ethers.getContractFactory('AutomationExecutor')

        ServiceRegistryInstance = await serviceRegistryFactory.deploy(0)
        ServiceRegistryInstance = await ServiceRegistryInstance.deployed()

        DummyCommandInstance = await dummyCommandFactory.deploy(ServiceRegistryInstance.address, true, true, false)
        DummyCommandInstance = await DummyCommandInstance.deployed()

        AutomationBotInstance = await automationBotFactory.deploy(ServiceRegistryInstance.address)
        AutomationBotInstance = await AutomationBotInstance.deployed()

        ExchangeInstance = await deployMockContract(owner, [
            'function swapTokenForDai(address,uint256,uint256,address,bytes)',
        ])
        await ExchangeInstance.mock.swapTokenForDai.returns()

        MockERC20Instance = await deployMockContract(owner, [
            'function balanceOf(address) returns (uint256)',
            'function allowance(address,address) returns (uint256)',
            'function approve(address,uint256) returns (bool)',
        ])
        // mock defaults
        await MockERC20Instance.mock.balanceOf.returns(0)
        await MockERC20Instance.mock.allowance.returns(0)
        await MockERC20Instance.mock.approve.returns(true)

        AutomationExecutorInstance = await automationExecutorFactory.deploy(
            AutomationBotInstance.address,
            ExchangeInstance.address,
        )
        AutomationExecutorInstance = await AutomationExecutorInstance.deployed()

        await ServiceRegistryInstance.addNamedService(
            await ServiceRegistryInstance.getServiceNameHash(AutomationServiceName.CDP_MANAGER),
            CDP_MANAGER_ADDRESS,
        )

        await ServiceRegistryInstance.addNamedService(
            await ServiceRegistryInstance.getServiceNameHash(AutomationServiceName.AUTOMATION_BOT),
            AutomationBotInstance.address,
        )

        await ServiceRegistryInstance.addNamedService(
            await ServiceRegistryInstance.getServiceNameHash(AutomationServiceName.AUTOMATION_EXECUTOR),
            AutomationExecutorInstance.address,
        )

        // await (await ServiceRegistryInstance.addTrustedAddress(AutomationExecutorInstance.address)).wait()

        const hash = getCommandHash(TriggerType.CLOSE_TO_DAI)
        await ServiceRegistryInstance.addNamedService(hash, DummyCommandInstance.address)

        const cdpManagerInstance = await ethers.getContractAt('ManagerLike', CDP_MANAGER_ADDRESS)

        const proxyAddress = await cdpManagerInstance.owns(testCdpId)
        usersProxy = await ethers.getContractAt('DsProxyLike', proxyAddress)
        proxyOwnerAddress = await usersProxy.owner()
    })

    beforeEach(async () => {
        snapshotId = await ethers.provider.send('evm_snapshot', [])
    })

    afterEach(async () => {
        await ethers.provider.send('evm_revert', [snapshotId])
    })

    describe('setExchange', async () => {
        it('should successfully set new exchange address', async () => {
            const address = generateRandomAddress()
            await AutomationExecutorInstance.setExchange(address)
            const newAddress = await AutomationExecutorInstance.exchange()
            expect(newAddress.toLowerCase()).to.eq(address)
        })

        it('should revert with executor/only-owner on unauthorized sender', async () => {
            const exchange = generateRandomAddress()
            const tx = AutomationExecutorInstance.connect(notOwner).setExchange(exchange)
            await expect(tx).to.be.revertedWith('executor/only-owner')
        })
    })

    describe('addCaller', () => {
        it('should be able to whitelist new callers', async () => {
            const caller = generateRandomAddress()
            expect(await AutomationExecutorInstance.callers(caller)).to.be.false
            await AutomationExecutorInstance.addCaller(caller)
            expect(await AutomationExecutorInstance.callers(caller)).to.be.true
        })

        it('should revert with executor/only-owner on unauthorized sender', async () => {
            const caller = generateRandomAddress()
            const tx = AutomationExecutorInstance.connect(notOwner).addCaller(caller)
            await expect(tx).to.be.revertedWith('executor/only-owner')
        })
    })

    describe('removeCaller', () => {
        it('should be able to whitelist new callers', async () => {
            const caller = generateRandomAddress()
            await AutomationExecutorInstance.addCaller(caller)
            expect(await AutomationExecutorInstance.callers(caller)).to.be.true
            await AutomationExecutorInstance.removeCaller(caller)
            expect(await AutomationExecutorInstance.callers(caller)).to.be.false
        })

        it('should revert with executor/only-owner on unauthorized sender', async () => {
            const caller = generateRandomAddress()
            const tx = AutomationExecutorInstance.connect(notOwner).removeCaller(caller)
            await expect(tx).to.be.revertedWith('executor/only-owner')
        })

        it('should revert with executor/cannot-remove-owner if owner tries to remove themselves', async () => {
            const tx = AutomationExecutorInstance.removeCaller(await owner.getAddress())
            await expect(tx).to.be.revertedWith('executor/cannot-remove-owner')
        })
    })

    describe('execute', async () => {
        const triggerData = '0x'
        let triggerId = 0

        before(async () => {
            const newSigner = await impersonate(proxyOwnerAddress)

            const dataToSupply = AutomationBotInstance.interface.encodeFunctionData('addTrigger', [
                testCdpId,
                2,
                0,
                triggerData,
            ])
            const tx = await usersProxy.connect(newSigner).execute(AutomationBotInstance.address, dataToSupply)
            const result = await tx.wait()

            const filteredEvents = getEvents(
                result,
                'event TriggerAdded(uint256 indexed triggerId, address indexed commandAddress, uint256 indexed cdpId, bytes triggerData)',
                'TriggerAdded',
            )

            triggerId = filteredEvents[0].args.triggerId.toNumber()
        })

        it('should not revert on successful execution', async () => {
            await DummyCommandInstance.changeFlags(true, true, false)
            const tx = AutomationExecutorInstance.execute(
                '0x',
                testCdpId,
                triggerData,
                DummyCommandInstance.address,
                triggerId,
            )
            await expect(tx).not.to.be.reverted
        })

        it('should revert with executor/not-authorized on unauthorized sender', async () => {
            await DummyCommandInstance.changeFlags(true, true, false)
            const tx = AutomationExecutorInstance.connect(notOwner).execute(
                '0x',
                testCdpId,
                triggerData,
                DummyCommandInstance.address,
                triggerId,
            )
            await expect(tx).to.be.revertedWith('executor/not-authorized')
        })
    })

    describe('swapTokenForDai', () => {
        it('should successfully execute swap token for dai', async () => {
            await MockERC20Instance.mock.balanceOf.returns(100)
            await MockERC20Instance.mock.approve.returns(true)
            await MockERC20Instance.mock.allowance.returns(0)
            const tx = AutomationExecutorInstance.swapTokenForDai(
                MockERC20Instance.address,
                99,
                1,
                constants.AddressZero,
                '0x',
            )
            await expect(tx).not.to.be.reverted
        })

        it('should not call approve with sufficient prior allowance', async () => {
            await MockERC20Instance.mock.balanceOf.returns(100)
            await MockERC20Instance.mock.approve.returns(false) // approval fails
            await MockERC20Instance.mock.allowance.returns(99) // but allowance is sufficient
            const tx = AutomationExecutorInstance.swapTokenForDai(
                MockERC20Instance.address,
                99,
                1,
                constants.AddressZero,
                '0x',
            )
            await expect(tx).not.to.be.reverted
        })

        it('should revert with executor/approval-failed on approval failing', async () => {
            await MockERC20Instance.mock.balanceOf.returns(100)
            await MockERC20Instance.mock.approve.returns(false)
            const tx = AutomationExecutorInstance.swapTokenForDai(
                MockERC20Instance.address,
                99,
                1,
                constants.AddressZero,
                '0x',
            )
            await expect(tx).to.be.revertedWith('executor/approval-failed')
        })

        it('should revert with executor/invalid-amount on amount greater or equal to balance provided', async () => {
            await MockERC20Instance.mock.balanceOf.returns(100)
            const tx = AutomationExecutorInstance.swapTokenForDai(
                MockERC20Instance.address,
                100,
                1,
                constants.AddressZero,
                '0x',
            )
            await expect(tx).to.be.revertedWith('executor/invalid-amount')

            const tx2 = AutomationExecutorInstance.swapTokenForDai(
                MockERC20Instance.address,
                101,
                1,
                constants.AddressZero,
                '0x',
            )
            await expect(tx2).to.be.revertedWith('executor/invalid-amount')
        })

        it('should revert with executor/invalid-amount on 0 amount provided', async () => {
            const tx = AutomationExecutorInstance.swapTokenForDai(
                MockERC20Instance.address,
                0,
                1,
                constants.AddressZero,
                '0x',
            )
            await expect(tx).to.be.revertedWith('executor/invalid-amount')
        })

        it('should revert with executor/not-authorized on unauthorized sender', async () => {
            const tx = AutomationExecutorInstance.connect(notOwner).swapTokenForDai(
                MockERC20Instance.address,
                1,
                1,
                constants.AddressZero,
                '0x',
            )
            await expect(tx).to.be.revertedWith('executor/not-authorized')
        })
    })
})
