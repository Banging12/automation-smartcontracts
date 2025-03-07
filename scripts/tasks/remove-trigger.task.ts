import BigNumber from 'bignumber.js'
import { types } from 'hardhat/config'
import { coalesceNetwork, HardhatUtils, Network } from '../common'
import { BaseTaskArgs, createTask } from './base.task'
import { params } from './params'

interface RemoveTriggerArgs extends BaseTaskArgs {
    trigger: BigNumber
    allowance: boolean
    forked?: Network
}

createTask<RemoveTriggerArgs>('remove-trigger', 'Removes a trigger for a user')
    .addParam('trigger', 'The trigger ID', '', params.bignumber)
    .addParam('allowance', 'The flag whether to remove allowance', false, types.boolean)
    .setAction(async (args: RemoveTriggerArgs, hre) => {
        const { name: network } = hre.network
        console.log(
            `Network: ${network}. Using addresses from ${coalesceNetwork(args.forked || (network as Network))}\n`,
        )
        const hardhatUtils = new HardhatUtils(hre, args.forked)

        const bot = await hre.ethers.getContractAt('AutomationBot', hardhatUtils.addresses.AUTOMATION_BOT)
        const storage = await hre.ethers.getContractAt(
            'AutomationBotStorage',
            hardhatUtils.addresses.AUTOMATION_BOT_STORAGE,
        )

        /*         const triggerInfo = await storage.activeTriggers(args.trigger.toString())
        if (triggerInfo.commandAddress.eq('0x0000000000000000000000000000000000000000')) {
            throw new Error(`Trigger with id ${args.trigger.toString()} is not active`)
        }

        let signer: Signer = hre.ethers.provider.getSigner(0)
        console.log(`Address: ${await signer.getAddress()}`)

        const cdpManager = await hre.ethers.getContractAt('ManagerLike', hardhatUtils.addresses.CDP_MANAGER)
        const proxyAddress = await cdpManager.owns(vault)
        const proxy = await hre.ethers.getContractAt('DsProxyLike', proxyAddress)
        const currentProxyOwner = await proxy.owner()
        if (currentProxyOwner.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
            if (!isLocalNetwork(network)) {
                throw new Error(
                    `Signer is not an owner of the proxy. Cannot impersonate on external network. Signer: ${await signer.getAddress()}. Owner: ${currentProxyOwner}`,
                )
            }
            console.log(`Impersonating proxy owner ${currentProxyOwner}...`)
            signer = await hardhatUtils.impersonate(currentProxyOwner)
        }

        const removeTriggerData = bot.interface.encodeFunctionData('removeTriggers', [
            [args.trigger.toString()],
            args.allowance,
        ])

        const info = [
            `Vault ID: ${vault}`,
            `Allowance Removed: ${args.allowance}`,
            `Automation Bot: ${bot.address}`,
            `DSProxy: ${proxyAddress}`,
            `Signer: ${await signer.getAddress()}`,
        ]
        if (args.dryrun) {
            console.log(info.join('\n'))
            return
        }

        const tx = await proxy.connect(signer).execute(bot.address, removeTriggerData)
        const receipt = await tx.wait()

        const [triggerRemovedEvent] = getEvents(receipt, bot.interface.getEvent('TriggerRemoved'))
        if (!triggerRemovedEvent) {
            throw new Error(`Failed to remove trigger. Contract Receipt: ${JSON.stringify(receipt)}`)
        }

        console.log([`Trigger with id ${args.trigger.toString()} was succesfully removed`].concat(info).join('\n')) */
    })
