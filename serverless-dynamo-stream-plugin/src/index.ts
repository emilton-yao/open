'use strict';

import Dynamo from 'aws-sdk/clients/dynamodb';
import Iam from 'aws-sdk/clients/iam';
import Lambda from 'aws-sdk/clients/lambda';
import { config } from 'aws-sdk';
import Serverless from 'serverless'

export enum DynamoStreamType {
  NEW_IMAGE = 'NEW_IMAGE',
  OLD_IMAGE = 'OLD_IMAGE',
  NEW_AND_OLD_IMAGES = 'NEW_AND_OLD_IMAGES',
  KEYS_ONLY = 'KEYS_ONLY',
}

export enum EventSourcePosition {
  TRIM_HORIZON = 'TRIM_HORIZON',
  LATEST = 'LATEST',
  AT_TIMESTAMP = 'AT_TIMESTAMP',
}

export class DynamoStream implements IDynamoStream {
  tableName: string;
  streamType: DynamoStreamType = DynamoStreamType.NEW_AND_OLD_IMAGES;
  startingPosition: EventSourcePosition = EventSourcePosition.LATEST;

  constructor(stream: IDynamoStream) {
    this.tableName = stream.tableName;

    // set some optional params if they are present
    if (stream.streamType) {
      this.streamType = stream.streamType;
    }
    if (stream.startingPosition) {
      this.startingPosition = stream.startingPosition;
    }
  }
}

export interface IDynamoStream {
  tableName: string;
  streamType?: DynamoStreamType;
  startingPosition?: EventSourcePosition;
}

export class ServerlessDynamoStreamPlugin {

  readonly dynamoClient: Dynamo;
  readonly iamClient: Iam;
  readonly lambdaClient: Lambda;

  // serverless parameters
  readonly serverless: Serverless;
  readonly options: Serverless.Options;

  /**
   * @description the key in serverless.yml
   */
  readonly existingStreamKey: string = 'existingDynamoStream';
  readonly requiredDynamoStreamPermissions = [
    'dynamodb:GetRecords',
    'dynamodb:GetShardIterator',
    'dynamodb:DescribeStream',
    'dynamodb:ListStreams'
  ];

  /**
   * @description hooks in the plugin command into the Serverless command lifecycle.
   */
  readonly hooks: { [key: string]: any };

  /**
   * @description exposes some commands for running it in the standalone mode.
   */
  readonly commands: { [key: string]: any };

  /**
   * @description number of milliseconds to wait for AWS to finalize all the things.
   */
  readonly finalWaitPeriod: number = 60000;

  constructor(serverless: Serverless, options: Serverless.Options) {
    this.serverless = serverless;
    this.options = options;

    // set the plugin to be runnable as a command
    this.commands = {
      'dynamo-stream': {
        usage: 'Creates and connects DynamoDB streams for pre-existing tables with AWS Lambdas',
        lifecycleEvents: ['create', 'connect'],
      },
    };

    // bind the lifecycle hooks
    this.hooks = {
      'dynamoStream:create': this.createDynamoStream.bind(this),
      'dynamoStream:connect': this.connectDynamoStreamToLambda.bind(this),
      'after:deploy:deploy': this.runAll.bind(this),
    };

    // configure AWS.
    config.update({
      region: serverless.service.provider.region,
      apiVersions: {
        dynamodb: '2012-08-10',
      }
    });

    // instantiate AWS clients
    this.dynamoClient = new Dynamo();
    this.lambdaClient = new Lambda();
    this.iamClient = new Iam();
  }

  async runAll() {
    await this.createDynamoStream();
    await this.connectDynamoStreamToLambda();
  }

  async createDynamoStream() {
    this.serverless.cli.log('dynamoStream:create - creating/updating DynamoDB streams if needed');
    const lambdaToStreams = this.getLambdaStreams();

    // Exit early if there are no existing streams in serverless.yml
    if (Object.keys(lambdaToStreams).length <= 0) {
      return Promise.resolve();
    }

    this.serverless.cli.log(`Found some lambdas for existing dynamo streams: ${Object.keys(lambdaToStreams)}`);

    // describe each table and create/update the stream if needed
    const promises = [];
    for (const [lambdaName, events] of Object.entries(lambdaToStreams)) {

      for (const event of events) {
        promises.push(this.dynamoClient.describeTable({ TableName: event.tableName }).promise()
          .then(response => Promise.resolve(response.Table))
          .then(table => {
            const stream = table.StreamSpecification;

            // update the stream if it's not enabled or its stream time is not what's specified in serverless.yml
            if (!stream || !stream.StreamEnabled || stream.StreamEnabled && stream.StreamViewType !== event.streamType) {
              const updateTableInput = {
                TableName: table.TableName,
                StreamSpecification: {
                  StreamEnabled: true,
                  StreamViewType: event.streamType,
                },
              };

              this.serverless.cli.log(`Updating the stream for table ${event.tableName} to ${event.streamType}`);
              return this.dynamoClient.updateTable(updateTableInput).promise();
            }
          })
          .then(updateTableResult => {
            this.serverless.cli.log(`Set the stream for table ${event.tableName} to ${event.streamType}`);
            Promise.resolve(updateTableResult);
          })
          .catch(error => {
            this.serverless.cli.log(`Error updating the stream ${error.message}`);
            throw error;
          })
        );
      }
    }

    // run it all and return a promise which serverless needs to understand what's up
    return Promise.all(promises);
  }

  connectDynamoStreamToLambda() {
    this.serverless.cli.log('dynamoStream:create - connecting lambdas to DynamoDB streams');
    const lambdaToStreams = this.getLambdaStreams();

    // Exit early if there are no existing streams in serverless.yml
    if (Object.keys(lambdaToStreams).length <= 0) {
      return Promise.resolve();
    }

    this.serverless.cli.log(`Following lambdas needs some connections: ${Object.keys(lambdaToStreams)}`);

    const promise = Promise.resolve();

    for (const [lambdaName, events] of Object.entries(lambdaToStreams)) {
      const functionObject = this.serverless.service.functions[lambdaName];
      const fullLambdaName = functionObject.name;

      for (const event of events) {
        const update = {};

        promise
          .then(() => this.dynamoClient.describeTable({ TableName: event.tableName }).promise() // call aws to describe a table
            .then(response => Promise.resolve(response.Table)) // get a table from the response
            .then(table => { // save the stream arn, fetch the lambda
              if (!table.LatestStreamArn) {
                throw new Error('Failed to find the stream arn to connect the lambda to');
              }

              update.streamArn = table.LatestStreamArn;
              this.serverless.cli.log(`Found dynamo stream arn ${update.streamArn}`);

              return this.lambdaClient.getFunctionConfiguration({ FunctionName: fullLambdaName }).promise();
            })
            .then(functionConfiguration => { // get a lambda role name from the arn, save the name
              const lambdaRoleArn = functionConfiguration.Role;
              if (!lambdaRoleArn) {
                throw new Error('Function configuration doesn\'t have a role.' +
                  ' Please make sure serverless deploy succeeds to deploy the lambdas first.');
              }

              const fullLambdaRoleName = lambdaRoleArn.split(':').pop();
              const lambdaRoleName = fullLambdaRoleName.split('/').pop();
              if (!lambdaRoleName) {
                throw new Error(`Lambda role arn ${lambdaRoleArn} doesn\'t have a name.` +
                  ` Make sure the right role is set on lambda ${fullLambdaName}.`);
              }

              this.serverless.cli.log(`Fetched role name ${lambdaRoleName} for lambda ${fullLambdaName}`);

              update.lambdaRoleName = lambdaRoleName;
              return Promise.resolve(lambdaRoleName);
            })
            .then(lambdaRoleName => this.iamClient.listRolePolicies({ RoleName: lambdaRoleName }).promise()) // get role policies
            .then(rolePoliciesResponse => { // find the policy name
              const policyNames = rolePoliciesResponse.PolicyNames;
              update.policyName = policyNames.find(name => name.includes(this.serverless.service.service));
              this.serverless.cli.log(`Found policy name ${update.policyName} for lambda ${fullLambdaName}`);
              return Promise.resolve(update.policyName);
            })
            .then(policyName => { // get role policy by policy name
              if (policyName) {
                const params = { RoleName: update.lambdaRoleName, PolicyName: update.policyName };
                return Promise.resolve(this.iamClient.getRolePolicy(params).promise());
              } else {
                // TODO: create a new policy and attach it to the role
                throw new Error('Failed to find the policy name for the lambda role.' +
                  ' Please make sure serverless deploy succeeds with deploying lambdas first.' +
                  ' Since it creates this role as a part of the process.')
              }
            })
            .then(getRolePolicyResponse => { // create a dynamo stream policy for lambda role if needed
              const policyDocument = JSON.parse(decodeURIComponent(getRolePolicyResponse.PolicyDocument));
              const alreadyAllowsDynamoStream = policyDocument.Statement
                .some(statement => statement.Resource.includes(update.streamArn)
                  && this.requiredDynamoStreamPermissions.every(requiredPermission => statement.Action.includes(requiredPermission))
                  && statement.Effect === 'Allow');

              if (alreadyAllowsDynamoStream) {
                this.serverless.cli.log(`Role ${update.lambdaRoleName} already has a policy for ${update.streamArn}`);
                return Promise.resolve();
              }

              // add a new policy to the existing document
              policyDocument.Statement.push({
                Action: this.requiredDynamoStreamPermissions,
                Resource: [update.streamArn],
                Effect: 'Allow',
              });

              // create the new policy on AWS
              this.serverless.cli.log(`Creating a new policy for Role ${update.lambdaRoleName} to access the stream ${update.streamArn}`);
              const params = {
                RoleName: update.lambdaRoleName,
                PolicyName: update.policyName,
                PolicyDocument: JSON.stringify(policyDocument),
              };
              return this.iamClient.putRolePolicy(params).promise();
            })
            .then(() => this.lambdaClient.listEventSourceMappings({ FunctionName: fullLambdaName }).promise()) // fetch existing event source mappings
            .then(eventSourceMappingResponse => { // create the event mapping between the lambda and the stream
              const existingEventSourceMappings = eventSourceMappingResponse.EventSourceMappings;
              const existingMapping = existingEventSourceMappings.find(mapping => mapping.EventSourceArn === update.streamArn);

              if (existingMapping) {
                this.serverless.cli.log(
                  `Mapping between lambda ${lambdaName} and DynamoDB stream for table ${event.tableName} already exists`
                );
                return Promise.resolve();
              }

              return new Promise(resolve => { // wait until AWS finalizes all things and then create an event
                this.serverless.cli.log('Hang tight, AWS is doing some housekeeping.' +
                  ` We'll wait for ${this.finalWaitPeriod / 1000} seconds before creating the event mapping just to make sure.`);

                // TODO: implement exponential backoff with max retries
                setTimeout(() => {
                  const params = { RoleName: update.lambdaRoleName, PolicyName: update.policyName };
                  resolve(this.iamClient.getRolePolicy(params).promise());
                }, this.finalWaitPeriod)
              })
                .then(getRolePolicyResponse => {
                  const policyDocument = JSON.parse(decodeURIComponent(getRolePolicyResponse.PolicyDocument));
                  const alreadyAllowsDynamoStream = policyDocument.Statement
                    .some(statement => statement.Resource.includes(update.streamArn)
                      && this.requiredDynamoStreamPermissions.every(requiredPermission => statement.Action.includes(requiredPermission))
                      && statement.Effect === 'Allow');

                  if (alreadyAllowsDynamoStream) {
                    this.serverless.cli.log(`Confirmed Role ${update.lambdaRoleName} has a policy for ${update.streamArn}`);
                    return Promise.resolve();
                  } else {
                    throw new Error(`Failed to fetch a policy for the role ${update.lambdaRoleName}.` +
                      'Please make sure the policy is in place and retry again.');
                  }
                })
                .then(() => { // now create an event mapping
                  const startingPosition = event.startingPosition;
                  // TODO: set the optional params based on event params from serverless.yml.
                  const params = {
                    EventSourceArn: update.streamArn,
                    FunctionName: fullLambdaName,
                    StartingPosition: startingPosition,
                  };
                  this.serverless.cli.log(
                    `Creating event mapping between lambda ${lambdaName} and DynamoDB stream for table ${event.tableName}`
                  );
                  return this.lambdaClient.createEventSourceMapping(params).promise();
                })
            })
            .catch(error => {
              this.serverless.cli.log(`Error creating event mapping ${error.message}`);
              throw error;
            }));
      }
    }

    return promise;
  }

  /**
   * @description returns an object containing a lambda name as a key and the array of streams as a value.
   */
  getLambdaStreams(): { [key: string]: DynamoStream[] } {
    const lambdaToStreams: { [key: string]: DynamoStream[] } = {};

    // find all lambdas that have a custom event in their attributes
    for (const functionName of this.serverless.service.getAllFunctions()) {
      const events = this.serverless.service.getAllEventsInFunction(functionName);
      const existingStreamEvents = events.filter(event => (event as any)[this.existingStreamKey]);
      if (existingStreamEvents.length > 0) {
        lambdaToStreams[functionName] = existingStreamEvents
          .map(event => new DynamoStream((event as any)[this.existingStreamKey] as IDynamoStream));
      }
    }

    return lambdaToStreams;
  }

}

module.exports = ServerlessDynamoStreamPlugin;
