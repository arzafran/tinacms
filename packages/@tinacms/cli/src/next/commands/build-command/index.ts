import fetch, { Headers } from 'node-fetch'
import { Command, Option } from 'clipanion'
import Progress from 'progress'
import fs from 'fs-extra'
import { buildSchema, getASTSchema, Database } from '@tinacms/graphql'
import { ConfigManager } from '../../config-manager'
import { logger, summary } from '../../../logger'
import { buildProductionSpa } from './server'
import { Codegen } from '../../codegen'
import { parseURL } from '@tinacms/schema-tools'
import {
  buildASTSchema,
  buildClientSchema,
  getIntrospectionQuery,
} from 'graphql'
import { diff } from '@graphql-inspector/core'
import { IndexStatusResponse, waitForDB } from './waitForDB'
import { createAndInitializeDatabase, createDBServer } from '../../database'
import { sleepAndCallFunc } from '../../../utils/sleep'
import { dangerText, linkText } from '../../../utils/theme'

export class BuildCommand extends Command {
  static paths = [['build']]
  rootPath = Option.String('--rootPath', {
    description:
      'Specify the root directory to run the CLI from (defaults to current working directory)',
  })
  verbose = Option.Boolean('-v,--verbose', false, {
    description: 'increase verbosity of logged output',
  })
  noSDK = Option.Boolean('--noSDK', false, {
    description:
      "DEPRECATED - This should now be set in the config at client.skip = true'. Don't generate the generated client SDK",
  })
  datalayerPort = Option.String('--datalayer-port', '9000', {
    description:
      'Specify a port to run the datalayer server on. (default 4001)',
  })
  isomorphicGitBridge = Option.Boolean('--isomorphicGitBridge', {
    description: 'DEPRECATED - Enable Isomorphic Git Bridge Implementation',
  })
  localOption = Option.Boolean('--local', {
    description: 'DEPRECATED: Uses the local file system graphql server',
  })
  experimentalDataLayer = Option.Boolean('--experimentalData', {
    description:
      'DEPRECATED - Build the server with additional data querying capabilities',
  })
  noTelemetry = Option.Boolean('--noTelemetry', false, {
    description: 'Disable anonymous telemetry that is collected',
  })
  tinaGraphQLVersion = Option.String('--tina-graphql-version', {
    description:
      'Specify the version of @tinacms/graphql to use (defaults to latest)',
  })

  static usage = Command.Usage({
    category: `Commands`,
    description: `Build the CMS and autogenerated modules for usage with Tina Cloud`,
  })

  async catch(error: any): Promise<void> {
    console.error(error)
    process.exit(1)
  }

  async execute(): Promise<number | void> {
    const configManager = new ConfigManager({
      rootPath: this.rootPath,
      tinaGraphQLVersion: this.tinaGraphQLVersion,
      legacyNoSDK: this.noSDK,
    })
    logger.info('Starting Tina build')
    if (this.isomorphicGitBridge) {
      logger.warn('--isomorphicGitBridge has been deprecated')
    }
    if (this.experimentalDataLayer) {
      logger.warn(
        '--experimentalDataLayer has been deprecated, the data layer is now built-in automatically'
      )
    }
    if (this.localOption) {
      logger.warn('--local has been deprecated')
    }
    if (this.noSDK) {
      logger.warn(
        '--noSDK has been deprecated, and will be unsupported in a future release. This should be set in the config at client.skip = true'
      )
    }

    try {
      await configManager.processConfig()
    } catch (e) {
      logger.error(e.message)
      logger.error('Unable to build, please fix your Tina config and try again')
      process.exit(1)
    }

    // Initialize the host TCP server
    createDBServer(Number(this.datalayerPort))
    const database = await createAndInitializeDatabase(configManager)
    const { queryDoc, fragDoc } = await buildSchema(
      database,
      configManager.config
    )

    const codegen = new Codegen({
      schema: await getASTSchema(database),
      configManager: configManager,
      queryDoc,
      fragDoc,
    })
    const apiURL = await codegen.execute()

    await this.checkClientInfo(configManager, apiURL)
    await waitForDB(configManager.config, apiURL, false)
    await this.checkGraphqlSchema(configManager, database, apiURL)

    await buildProductionSpa(configManager, database, apiURL)

    // Add the gitignore so the index.html and assets are committed to git
    await fs.outputFile(
      configManager.outputGitignorePath,
      'index.html\nassets/'
    )

    const summaryItems = []
    if (!configManager.shouldSkipSDK()) {
      summaryItems.push({
        emoji: '🤖',
        heading: 'Auto-generated files',
        subItems: [
          {
            key: 'GraphQL Client',
            value: configManager.printGeneratedClientFilePath(),
          },
          {
            key: 'Typescript Types',
            value: configManager.printGeneratedTypesFilePath(),
          },
        ],
      })
    }

    summary({
      heading: 'Tina build complete',
      items: [
        {
          emoji: '🦙',
          heading: 'Tina Config',
          subItems: [
            {
              key: 'API url',
              value: apiURL,
            },
          ],
        },
        ...summaryItems,
        // {
        //   emoji: '📚',
        //   heading: 'Useful links',
        //   subItems: [
        //     {
        //       key: 'Custom queries',
        //       value: 'https://tina.io/querying',
        //     },
        //     {
        //       key: 'Visual editing',
        //       value: 'https://tina.io/visual-editing',
        //     },
        //   ],
        // },
      ],
    })
    process.exit()
  }

  async checkClientInfo(configManager: ConfigManager, apiURL: string) {
    const { config } = configManager
    const token = config.token
    const { clientId, branch, host } = parseURL(apiURL)
    const url = `https://${host}/db/${clientId}/status/${branch}`
    const bar = new Progress('Checking clientId and token. :prog', 1)

    // Check the client information
    let branchKnown = false
    try {
      const res = await request({
        token,
        url,
      })
      bar.tick({
        prog: '✅',
      })
      if (!(res.status === 'unknown')) {
        branchKnown = true
      }
    } catch (e) {
      summary({
        heading: 'Error when checking client information',
        items: [
          {
            emoji: '❌',
            heading: 'You provided',
            subItems: [
              {
                key: 'clientId',
                value: config.clientId,
              },
              {
                key: 'token',
                value: config.token,
              },
            ],
          },
        ],
      })
      throw e
    }

    const branchBar = new Progress('Checking branch is on Tina Cloud. :prog', 1)

    // We know the branch is known (could be status: 'failed', 'inprogress' or 'success')
    if (branchKnown) {
      branchBar.tick({
        prog: '✅',
      })
      return
    }

    // We know the branch is status: 'unknown'

    // Check for a max of 6 times
    for (let i = 0; i <= 5; i++) {
      await sleepAndCallFunc({
        fn: async () => {
          const res = await request({
            token,
            url,
          })
          if (this.verbose) {
            logger.info(
              `Branch status: ${res.status}. Attempt: ${
                i + 1
              }. Trying again in 5 seconds.`
            )
          }
          if (!(res.status === 'unknown')) {
            branchBar.tick({
              prog: '✅',
            })
            return
          }
        },
        ms: 5000,
      })
    }

    branchBar.tick({
      prog: '❌',
    })

    // I wanted to use the summary function here but I was getting the following error:
    // RangeError: Invalid count value
    // at String.repeat (<anonymous>)
    // summary({
    //   heading: `ERROR: Branch '${branch}' is not on Tina Cloud. Please make sure that branch '${branch}' exists in your repository and that you have pushed your all changes to the remote. View all all branches and there current status here: https://app.tina.io/projects/${clientId}/configuration`,
    //   items: [
    //     {
    //       emoji: '❌',
    //       heading: 'You provided',
    //       subItems: [
    //         {
    //           key: 'branch',
    //           value: config.branch,
    //         },
    //       ],
    //     },
    //   ],
    // })
    logger.error(
      `${dangerText(
        `ERROR: Branch '${branch}' is not on Tina Cloud.`
      )} Please make sure that branch '${branch}' exists in your repository and that you have pushed your all changes to the remote. View all all branches and there current status here: ${linkText(
        `https://app.tina.io/projects/${clientId}/configuration`
      )}`
    )
    throw new Error('Branch is not on Tina Cloud')
  }

  async checkGraphqlSchema(
    configManager: ConfigManager,
    database: Database,
    apiURL: string
  ) {
    const bar = new Progress(
      'Checking local GraphQL Schema matches server. :prog',
      1
    )
    const { config } = configManager
    const token = config.token

    // Get the remote schema from the graphql endpoint
    const remoteSchema = await fetchRemoteGraphqlSchema({
      url: apiURL,
      token,
    })

    const remoteGqlSchema = buildClientSchema(remoteSchema)

    // This will always be the filesystem bridge.
    const localSchemaDocument = await database.getGraphQLSchemaFromBridge()
    const localGraphqlSchema = buildASTSchema(localSchemaDocument)
    const diffResult = await diff(localGraphqlSchema, remoteGqlSchema)

    if (diffResult.length === 0) {
      bar.tick({
        prog: '✅',
      })
    } else {
      bar.tick({
        prog: '❌',
      })
      let errorMessage = `The local GraphQL schema doesn't match the remote GraphQL schema. Please push up your changes to Github to update your remote GraphQL schema.`
      if (config?.branch) {
        errorMessage += `\n\nAdditional info: Branch: ${config.branch}, Client ID: ${config.clientId} `
      }
      throw new Error(errorMessage)
    }
  }
}

//  This was taken from packages/tinacms/src/unifiedClient/index.ts
// TODO: maybe move this to a shared util package?
async function request(args: {
  url: string
  token: string
}): Promise<{ status: string; timestamp: number }> {
  const headers = new Headers()
  if (args.token) {
    headers.append('X-API-KEY', args.token)
  }
  headers.append('Content-Type', 'application/json')

  const url = args?.url

  const res = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'follow',
  })
  const json = await res.json()
  if (!res.ok) {
    let additionalInfo = ''
    if (res.status === 401 || res.status === 403) {
      additionalInfo =
        'Please check that your client ID, URL and read only token are configured properly.'
    }
    if (json) {
      additionalInfo += `\n\nMessage from server: ${json.message}`
    }
    throw new Error(
      `Server responded with status code ${res.status}, ${res.statusText}. ${
        additionalInfo ? additionalInfo : ''
      } Please see our FAQ for more information: https://tina.io/docs/errors/faq/`
    )
  }
  if (json.errors) {
    throw new Error(
      `Unable to fetch, please see our FAQ for more information: https://tina.io/docs/errors/faq/

      Errors: \n\t${json.errors.map((error) => error.message).join('\n')}`
    )
  }
  return {
    status: json?.status,
    timestamp: json?.timestamp,
  } as { status: IndexStatusResponse['status']; timestamp: number }
}

export const fetchRemoteGraphqlSchema = async ({
  url,
  token,
}: {
  url: string
  token?: string
}) => {
  const headers = new Headers()
  if (token) {
    headers.append('X-API-KEY', token)
  }
  const body = JSON.stringify({ query: getIntrospectionQuery(), variables: {} })

  headers.append('Content-Type', 'application/json')

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
  })
  const data = await res.json()
  return data?.data
}
