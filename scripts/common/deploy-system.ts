import { AutomationBot, AutomationExecutor, CloseCommand, McdUtils, McdView, ServiceRegistry } from '../../typechain'
import { AddressRegistry } from './addresses'
import { HardhatUtils } from './hardhat.utils'
import { AutomationServiceName, Network, TriggerType } from './types'
import { getCommandHash, getServiceNameHash } from './utils'

export interface DeployedSystem {
    serviceRegistry: ServiceRegistry
    mcdUtils: McdUtils
    automationBot: AutomationBot
    automationExecutor: AutomationExecutor
    mcdView: McdView
    closeCommand: CloseCommand | undefined
}

export interface DeploySystemArgs {
    utils: HardhatUtils
    addCommands: boolean
    logDebug?: boolean
    addressOverrides?: Partial<AddressRegistry>
}

const createServiceRegistry = (serviceRegistryInstance: ServiceRegistry) => {
    return async (hash: string, address: string) => {
        const receipt = await serviceRegistryInstance.addNamedService(hash, address, {
            gasLimit: '100000',
        })
        return receipt.wait()
    }
}

export async function deploySystem({
    utils,
    addCommands,
    logDebug = false,
    addressOverrides = {},
}: DeploySystemArgs): Promise<DeployedSystem> {
    let CloseCommandInstance: CloseCommand | undefined

    const delay = utils.hre.network.name === Network.MAINNET ? 1800 : 0

    const { ethers } = utils.hre
    const addresses = { ...utils.addresses, ...addressOverrides }

    const serviceRegistryFactory = await ethers.getContractFactory('ServiceRegistry')
    const automationBotFactory = await ethers.getContractFactory('AutomationBot')
    const automationExecutorFactory = await ethers.getContractFactory('AutomationExecutor')
    const closeCommandFactory = await ethers.getContractFactory('CloseCommand')
    const mcdViewFactory = await ethers.getContractFactory('McdView')
    const mcdUtilsFactory = await ethers.getContractFactory('McdUtils')

    if (logDebug) console.log('Deploying ServiceRegistry....')

    const serviceRegistryDeployment = await serviceRegistryFactory.deploy(delay)
    const ServiceRegistryInstance = await serviceRegistryDeployment.deployed()

    const addServiceRegistryEntry = createServiceRegistry(ServiceRegistryInstance)

    if (logDebug) console.log('Deploying McdUtils.....')

    const mcdUtilsDeployment = await mcdUtilsFactory.deploy(
        ServiceRegistryInstance.address,
        addresses.DAI,
        addresses.DAI_JOIN,
        addresses.MCD_JUG,
    )
    const McdUtilsInstance = (await mcdUtilsDeployment.deployed()) as McdUtils

    if (logDebug) console.log('Deploying AutomationBot....')
    const automationBotDeployment = await automationBotFactory.deploy(ServiceRegistryInstance.address)
    const AutomationBotInstance = await automationBotDeployment.deployed()

    if (logDebug) console.log('Deploying AutomationExecutor.....')
    const automationExecutorDeployment = await automationExecutorFactory.deploy(
        AutomationBotInstance.address,
        addresses.DAI,
        addresses.WETH,
        addresses.EXCHANGE,
    )
    const AutomationExecutorInstance = await automationExecutorDeployment.deployed()

    if (logDebug) console.log('Deploying McdView.....')
    const mcdViewDeployment = await mcdViewFactory.deploy(
        addresses.MCD_VAT,
        addresses.CDP_MANAGER,
        addresses.MCD_SPOT,
        addresses.OSM_MOM,
        await ethers.provider.getSigner(0).getAddress(),
    )
    const McdViewInstance = await mcdViewDeployment.deployed()

    if (addCommands) {
        if (logDebug) console.log('Deploying CloseCommand.....')
        const closeCommandDeployment = await closeCommandFactory.deploy(ServiceRegistryInstance.address)
        CloseCommandInstance = await closeCommandDeployment.deployed()
        await McdViewInstance.approve(CloseCommandInstance.address, true)

        if (logDebug) console.log('Adding CLOSE_TO_COLLATERAL command to ServiceRegistry....')
        await addServiceRegistryEntry(getCommandHash(TriggerType.CLOSE_TO_COLLATERAL), CloseCommandInstance.address)

        if (logDebug) console.log('Adding CLOSE_TO_DAI command to ServiceRegistry....')
        await addServiceRegistryEntry(getCommandHash(TriggerType.CLOSE_TO_DAI), CloseCommandInstance.address)

        if (logDebug) console.log('Whitelisting CloseCommand on McdView...')
        await (await McdViewInstance.approve(CloseCommandInstance.address, true)).wait()
    }

    if (logDebug) console.log('Adding CDP_MANAGER to ServiceRegistry....')
    await addServiceRegistryEntry(getServiceNameHash(AutomationServiceName.CDP_MANAGER), addresses.CDP_MANAGER)

    if (logDebug) console.log('Adding AUTOMATION_BOT to ServiceRegistry....')
    await addServiceRegistryEntry(
        getServiceNameHash(AutomationServiceName.AUTOMATION_BOT),
        AutomationBotInstance.address,
    )

    if (logDebug) console.log('Adding MCD_VIEW to ServiceRegistry....')
    await addServiceRegistryEntry(getServiceNameHash(AutomationServiceName.MCD_VIEW), McdViewInstance.address)

    if (logDebug) console.log('Adding MULTIPLY_PROXY_ACTIONS to ServiceRegistry....')
    await addServiceRegistryEntry(
        getServiceNameHash(AutomationServiceName.MULTIPLY_PROXY_ACTIONS),
        addresses.MULTIPLY_PROXY_ACTIONS,
    )

    if (logDebug) console.log('Adding AUTOMATION_EXECUTOR to ServiceRegistry....')
    await addServiceRegistryEntry(
        getServiceNameHash(AutomationServiceName.AUTOMATION_EXECUTOR),
        AutomationExecutorInstance.address,
    )

    if (logDebug) console.log('Adding MCD_UTILS command to ServiceRegistry....')
    await addServiceRegistryEntry(getServiceNameHash(AutomationServiceName.MCD_UTILS), McdUtilsInstance.address)

    if (logDebug) {
        console.log(`ServiceRegistry deployed to: ${ServiceRegistryInstance.address}`)
        console.log(`AutomationBot deployed to: ${AutomationBotInstance.address}`)
        console.log(`AutomationExecutor deployed to: ${AutomationExecutorInstance.address}`)
        console.log(`MCDView deployed to: ${McdViewInstance.address}`)
        console.log(`MCDUtils deployed to: ${McdUtilsInstance.address}`)
        console.log(`CloseCommand deployed to: ${CloseCommandInstance?.address}`)
    }

    return {
        serviceRegistry: ServiceRegistryInstance,
        mcdUtils: McdUtilsInstance,
        automationBot: AutomationBotInstance,
        automationExecutor: AutomationExecutorInstance,
        mcdView: McdViewInstance,
        closeCommand: CloseCommandInstance,
    }
}
