import {
  AppInstanceInfo,
  AppInstanceJson,
  IRpcNodeProvider,
  Node
} from "@counterfactual/types";
import { BigNumber, bigNumberify } from "ethers/utils";
import EventEmitter from "eventemitter3";
import {
  jsonRpcDeserialize,
  JsonRpcNotification,
  JsonRpcResponse,
  jsonRpcSerializeAsResponse
} from "rpc-server";

import { AppInstance } from "./app-instance";
import { CounterfactualEvent, EventType } from "./types";

/**
 * Milliseconds until a method request to the Node is considered timed out.
 */
export const NODE_REQUEST_TIMEOUT = 30000;

/**
 * Provides convenience methods for interacting with a Counterfactual node
 */
export class Provider {
  /** @ignore */
  private readonly requestListeners: {
    [requestId: string]: (msg: JsonRpcResponse) => void;
  } = {};
  /** @ignore */
  private readonly eventEmitter = new EventEmitter();
  /** @ignore */
  private readonly appInstances: { [appInstanceId: string]: AppInstance } = {};

  /**
   * Construct a new instance
   * @param nodeProvider NodeProvider instance that enables communication with the Counterfactual node
   */
  constructor(readonly nodeProvider: IRpcNodeProvider) {
    this.nodeProvider.onMessage(this.onNodeMessage.bind(this));
  }

  /**
   * Install a non-virtual app instance given its ID.
   *
   * @note
   * Installs non-virtual app instances i.e. in a direct channel between you and your peer.
   * For virtual app instances use [[installVirtual]].
   *
   * @async
   *
   * @param appInstanceId ID of the app instance to be installed, generated using [[AppFactory.proposeInstall]]
   * @return Installed AppInstance
   */
  async install(appInstanceId: string): Promise<AppInstance> {
    const response = await this.callRawNodeMethod(Node.RpcMethodName.INSTALL, {
      appInstanceId
    });
    const { appInstance } = response.result as Node.InstallResult;
    return this.getOrCreateAppInstance(appInstanceId, appInstance);
  }

  /**
   * Install a virtual app instance given its ID and a list of intermediaryIdentifier.
   *
   * @note
   * Installs virtual app instances i.e. routed through at least one intermediary channel.
   * For non-virtual app instances use [[install]].
   *
   * @async
   *
   * @param appInstanceId ID of the app instance to be installed, generated with [[AppFactory.proposeInstallVirtual]].
   * @param intermediaryIdentifier Xpub of intermediary peer to route installation through
   * @return Installed AppInstance
   */
  async installVirtual(
    appInstanceId: string,
    intermediaryIdentifier: string
  ): Promise<AppInstance> {
    const response = await this.callRawNodeMethod(
      Node.RpcMethodName.INSTALL_VIRTUAL,
      {
        appInstanceId,
        intermediaryIdentifier
      }
    );
    const { appInstance } = response.result as Node.InstallVirtualResult;
    return this.getOrCreateAppInstance(appInstanceId, appInstance);
  }

  /**
   * Reject installation of a proposed app instance
   *
   * @async
   *
   * @param appInstanceId ID of the app instance to reject
   */
  async rejectInstall(appInstanceId: string) {
    await this.callRawNodeMethod(Node.RpcMethodName.REJECT_INSTALL, {
      appInstanceId
    });
  }

  /**
   * Creates a channel by deploying a multisignature wallet contract.
   *
   * @async
   *
   * @param owners The channel's owning addresses
   * @return multisigAddress for the channel creation
   */
  async createChannel(owners: string[]): Promise<string> {
    const response = await this.callRawNodeMethod(
      Node.RpcMethodName.CREATE_CHANNEL,
      {
        owners
      }
    );

    const {
      multisigAddress
    } = response.result as Node.CreateChannelTransactionResult;

    return multisigAddress;
  }

  /**
   * Deploys a multisignature wallet contract for the channel.
   *
   * @param multisigAddress address of the multisig to be deployed
   * @return transactionHash of deployment transaction
   */
  async deployStateDepositHolder(multisigAddress: string): Promise<string> {
    const deployResponse = await this.callRawNodeMethod(
      Node.RpcMethodName.DEPLOY_STATE_DEPOSIT_HOLDER,
      {
        multisigAddress
      }
    );

    const {
      transactionHash
    } = deployResponse.result as Node.DeployStateDepositHolderResult;

    return transactionHash;
  }

  /**
   * Deposits the specified amount of funds into the channel
   * with the specified multisig address.
   *
   * @async
   *
   * @param multisigAddress string of the state channel multisig
   * @param amount BigNumber representing the deposit's value
   */
  async deposit(multisigAddress: string, amount: BigNumber) {
    await this.callRawNodeMethod(Node.RpcMethodName.DEPOSIT, {
      multisigAddress,
      amount
    });
  }

  /**
   * Withdraws the specified amount of funds into the channel
   * with the specified multisig address.
   *
   * @async
   *
   * @param multisigAddress string of the state channel multisig
   * @param amount BigNumber representing the deposit's value
   * @param recipient string of the party that should receive the withdrawn funds
   */
  async withdraw(
    multisigAddress: string,
    amount: BigNumber,
    recipient: string
  ) {
    await this.callRawNodeMethod(Node.RpcMethodName.WITHDRAW, {
      multisigAddress,
      recipient,
      amount
    });
  }

  /**
   * Queries for the current free balance state of the channel
   * with the specified multisig address.
   *
   * @async
   *
   * @param multisigAddress string of the state channel multisig
   * @return GetFreeBalanceStateResult
   */
  async getFreeBalanceState(
    multisigAddress: string
  ): Promise<Node.GetFreeBalanceStateResult> {
    const response = await this.callRawNodeMethod(
      Node.RpcMethodName.GET_FREE_BALANCE_STATE,
      {
        multisigAddress
      }
    );

    const freeBalances = Object.keys(response.result).reduce(
      (freeBalances, key) => {
        freeBalances[key] = bigNumberify(response.result[key]);

        return freeBalances;
      },
      {}
    );

    return freeBalances as Node.GetFreeBalanceStateResult;
  }

  /**
   * Subscribe to event.
   *
   * @async
   *
   * @param eventType Event type to subscribe to.
   * @param callback Function to be called when event is fired.
   */
  on(eventType: EventType, callback: (e: CounterfactualEvent) => void) {
    this.eventEmitter.on(eventType, callback);
  }

  /**
   * Subscribe to event. Unsubscribe once event is fired once.
   *
   * @param eventType Event type to subscribe to.
   * @param callback Function to be called when event is fired.
   */
  once(eventType: EventType, callback: (e: CounterfactualEvent) => void) {
    this.eventEmitter.once(eventType, callback);
  }

  /**
   * Unsubscribe from event.
   *
   * @param eventType Event type to unsubscribe from.
   * @param callback Original callback passed to subscribe call.
   */
  off(eventType: EventType, callback: (e: CounterfactualEvent) => void) {
    this.eventEmitter.off(eventType, callback);
  }

  /**
   * Call a Node method
   *
   * @param methodName Name of Node method to call
   * @param params Method-specific parameter object
   */
  async callRawNodeMethod(
    methodName: Node.RpcMethodName,
    params: Node.MethodParams
  ): Promise<Node.MethodResponse> {
    const requestId = new Date().valueOf();

    return new Promise<Node.MethodResponse>((resolve, reject) => {
      const request = jsonRpcDeserialize({
        params,
        jsonrpc: "2.0",
        method: methodName,
        id: requestId
      });
      // // @ts-ignore
      // request.params = request.parameters;

      if (!request.methodName) {
        return this.handleNodeError({
          jsonrpc: "2.0",
          result: {
            type: EventType.ERROR,
            data: {
              errorName: "unexpected_event_type"
            }
          },
          id: requestId
        });
      }

      this.requestListeners[requestId] = response => {
        if (response.result.type === Node.ErrorType.ERROR) {
          return reject(
            jsonRpcSerializeAsResponse(
              {
                ...response.result,
                type: EventType.ERROR
              },
              requestId
            )
          );
        }

        if (response.result.type !== methodName) {
          return reject(
            jsonRpcSerializeAsResponse(
              {
                type: EventType.ERROR,
                data: {
                  errorName: "unexpected_message_type",
                  message: `Unexpected response type. Expected ${methodName}, got ${response.result.type}`
                }
              },
              requestId
            )
          );
        }

        resolve(response.result);
      };

      setTimeout(() => {
        if (this.requestListeners[requestId] !== undefined) {
          reject({
            type: EventType.ERROR,
            data: {
              errorName: "request_timeout",
              message: `Request timed out: ${JSON.stringify(request)}`
            }
          });
          delete this.requestListeners[requestId];
        }
      }, NODE_REQUEST_TIMEOUT);

      this.nodeProvider.sendMessage(request);
    });
  }

  /**
   * Get app instance given its ID.
   * If one doesn't exist, it will be created and its details will be loaded from the Node.
   *
   * @param id ID of app instance
   * @param info Optional info to be used to create app instance if it doesn't exist
   * @return App instance
   */
  async getOrCreateAppInstance(
    id: string,
    info?: AppInstanceInfo | AppInstanceJson
  ): Promise<AppInstance> {
    if (!(id in this.appInstances)) {
      let newInfo;
      if (info) {
        newInfo = info;
      } else {
        const { result } = await this.callRawNodeMethod(
          Node.RpcMethodName.GET_APP_INSTANCE_DETAILS,
          { appInstanceId: id }
        );
        newInfo = (result as Node.GetAppInstanceDetailsResult).appInstance;
      }
      this.appInstances[id] = new AppInstance(newInfo, this);
    }
    return this.appInstances[id];
  }

  /**
   * @ignore
   */
  private onNodeMessage(
    message: JsonRpcNotification | JsonRpcResponse | Node.Event
  ) {
    const type = message["jsonrpc"]
      ? (message as JsonRpcNotification | JsonRpcResponse).result.type
      : (message as Node.Event).type;

    if (Object.values(Node.ErrorType).indexOf(type) !== -1) {
      this.handleNodeError(message as JsonRpcResponse);
    } else if ("id" in message) {
      this.handleNodeMethodResponse(message as JsonRpcResponse);
    } else {
      this.handleNodeEvent(message as JsonRpcNotification | Node.Event);
    }
  }

  /**
   * @ignore
   */
  private handleNodeError(error: JsonRpcResponse) {
    const requestId = error.id;
    if (requestId && this.requestListeners[requestId]) {
      this.requestListeners[requestId](error);
      delete this.requestListeners[requestId];
    }
    this.eventEmitter.emit(error.result.type, error.result);
  }

  /**
   * @ignore
   */
  private handleNodeMethodResponse(response: JsonRpcResponse) {
    const { id } = response;
    if (id in this.requestListeners) {
      this.requestListeners[id](response);
      delete this.requestListeners[id];
    } else {
      const error = jsonRpcSerializeAsResponse(
        {
          type: EventType.ERROR,
          data: {
            errorName: "orphaned_response",
            message: `Response has no corresponding inflight request: ${JSON.stringify(
              response
            )}`
          }
        },
        Number(id)
      );
      this.eventEmitter.emit(error.result.type, error.result);
    }
  }

  /**
   * @ignore
   */
  private async handleNodeEvent(event: JsonRpcNotification | Node.Event) {
    const nodeEvent = event["jsonrpc"]
      ? (event as JsonRpcNotification | JsonRpcResponse).result
      : (event as Node.Event);

    switch (nodeEvent.type) {
      case Node.EventName.REJECT_INSTALL:
        return this.handleRejectInstallEvent(nodeEvent);

      case Node.EventName.INSTALL:
        return this.handleInstallEvent(nodeEvent);

      case Node.EventName.INSTALL_VIRTUAL:
        return this.handleInstallVirtualEvent(nodeEvent);

      default:
        return this.handleGenericEvent(nodeEvent);
    }
  }

  /**
   * @ignore
   */
  private handleGenericEvent(nodeEvent: Node.Event) {
    return this.eventEmitter.emit(nodeEvent.type, nodeEvent);
  }

  /**
   * @ignore
   */
  private async handleInstallEvent(nodeEvent: Node.Event) {
    const { appInstanceId } = nodeEvent.data as Node.InstallEventData;
    const appInstance = await this.getOrCreateAppInstance(appInstanceId);
    const event = {
      type: EventType.INSTALL,
      data: {
        appInstance
      }
    };
    return this.eventEmitter.emit(event.type, event);
  }

  /**
   * @ignore
   */
  private async handleInstallVirtualEvent(nodeEvent: Node.Event) {
    const { appInstanceId } = nodeEvent.data["params"];
    const appInstance = await this.getOrCreateAppInstance(appInstanceId);
    const event = {
      type: EventType.INSTALL_VIRTUAL,
      data: {
        appInstance
      }
    };
    return this.eventEmitter.emit(event.type, event);
  }

  /**
   * @ignore
   */
  private async handleRejectInstallEvent(nodeEvent: Node.Event) {
    const data = nodeEvent.data as Node.RejectInstallEventData;
    const info = data.appInstance;
    const appInstance = await this.getOrCreateAppInstance(
      info.identityHash,
      info
    );
    const event = {
      type: EventType.REJECT_INSTALL,
      data: {
        appInstance
      }
    };
    return this.eventEmitter.emit(event.type, event);
  }
}
