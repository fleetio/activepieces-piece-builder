import { ApEdition, FlowRun, FlowTriggerType, isFailedState, isFlowRunStateTerminal, isManualPieceTrigger, isNil, RunEnvironment, UpdateRunProgressRequest, WebsocketClientEvent } from '@activepieces/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { websocketService } from '../../core/websockets.service'
import { alertsService } from '../../ee/alerts/alerts-service'
import { system } from '../../helper/system/system'
import { flowVersionService } from '../flow-version/flow-version.service'
import { flowService } from '../flow/flow.service'
import { flowFolderService } from '../folder/folder.service'
import { flowRunService } from './flow-run-service'
import { projectService } from 'src/app/project/project-service'

const paidEditions = [ApEdition.CLOUD, ApEdition.ENTERPRISE].includes(system.getEdition())
export const flowRunHooks = (log: FastifyBaseLogger) => ({
    async onFinish(flowRun: FlowRun): Promise<void> {
        if (!isFlowRunStateTerminal({
            status: flowRun.status,
            ignoreInternalError: true,
        })) {
            return
        }
        const flowVersion = await flowVersionService(log).getOne(flowRun.flowVersionId)
        const flow = await flowService(log).getOneById(flowRun.flowId)
        const folder = await flowFolderService(log).getOneById(flow?.folderId as string)
        const project = await projectService.getOne(flowRun.projectId)
        const isPieceTrigger = !isNil(flowVersion) && flowVersion.trigger.type === FlowTriggerType.PIECE && !isNil(flowVersion.trigger.settings.triggerName) 
        const isManualTrigger = isPieceTrigger && isManualPieceTrigger({ pieceName: flowVersion.trigger.settings.pieceName, triggerName: flowVersion.trigger.settings.triggerName })
        
        const externalId = `${project?.externalId}`
        const accountId = externalId.replace(/^([a-z]|-)*/, '')
        const sourceEnv = externalId.replace(/account-[0-9]*$/,'').replace('-','')

        // log the flow run here, success or failure
        if (isFailedState(flowRun.status)) {
            const populatedFlowRun = await flowRunService(log).getOnePopulatedOrThrow({ id: flowRun.id, projectId: flowRun.projectId })
            log.error({ 
                message: `Flow run failed ${populatedFlowRun.failedStep?.displayName}`, 
                environment: 'production',
                projectSourceEnv: `${sourceEnv}`,
                accountId: `${accountId}`,
                status: 'error', 
                folderName: folder?.displayName, 
                flowRun: populatedFlowRun 
            })
        } else {
            log.info({ 
                message: "Flow run Succeeded", 
                environment: 'production',
                projectSourceEnv: `${sourceEnv}`,
                accountId: `${accountId}`,
                status: 'ok', 
                folderName: folder?.displayName, 
                flowRun: flowRun 
            })
        }
        
        if (flowRun.environment === RunEnvironment.TESTING || isManualTrigger) {
            websocketService.to(flowRun.projectId).emit(WebsocketClientEvent.UPDATE_RUN_PROGRESS, {
                flowRun,
            } satisfies UpdateRunProgressRequest)
        }
        if (isFailedState(flowRun.status) && flowRun.environment === RunEnvironment.PRODUCTION && !isNil(flowRun.failedStep?.name)) {
            const date = dayjs(flowRun.created).toISOString()
            const issueToAlert = {
                projectId: flowRun.projectId,
                flowVersionId: flowRun.flowVersionId,
                flowId: flowRun.flowId,
                created: date,
            }

            if (paidEditions) {
                await alertsService(log).sendAlertOnRunFinish({ issueToAlert, flowRunId: flowRun.id })
            }
        }
        if (!paidEditions) {
            return
        }
    },
})
