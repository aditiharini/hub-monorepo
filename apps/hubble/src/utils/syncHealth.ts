import {
  Metadata,
  getInsecureHubRpcClient,
  getSSLHubRpcClient,
  toFarcasterTime,
  TrieNodePrefix,
  HubResult,
  HubRpcClient,
  TrieNodeMetadataResponse,
  Message,
  HubError,
  ContactInfoResponse,
} from "@farcaster/hub-nodejs";

import { NodeMetadata, MerkleTrie } from "network/sync/merkleTrie.js";

import { appendFile } from "fs/promises";

import { addressInfoFromGossip, addressInfoToString } from "./p2p.js";

import { SyncId, timestampToPaddedTimestampPrefix } from "../network/sync/syncId.js";
import { err, ok } from "neverthrow";
import { toTrieNodeMetadataResponse } from "../rpc/server.js";
import SyncEngine from "network/sync/syncEngine.js";

class SyncHealthMessageStats {
  primaryNumMessages: number;
  peerNumMessages: number;

  constructor(primaryNumMessages: number, peerNumMessages: number) {
    this.primaryNumMessages = primaryNumMessages;
    this.peerNumMessages = peerNumMessages;
  }

  computeDiff = () => {
    return Math.abs(this.primaryNumMessages - this.peerNumMessages);
  };

  computeDiffPercentage = () => {
    return this.computeDiff() / this.primaryNumMessages;
  };
}

class Stats {
  syncHealthMessageStats: SyncHealthMessageStats;
  resultsUploadingToPeer: HubResult<Message>[];
  resultsUploadingToPrimary: HubResult<Message>[];
  primary: string;
  peer: string;
  startTime: number;
  stopTime: number;

  constructor(
    startTime: number,
    stopTime: number,
    primary: string,
    peer: string,
    syncHealthMessageStats: SyncHealthMessageStats,
    resultsUploadingToPeer: HubResult<Message>[],
    resultsUploadingToPrimary: HubResult<Message>[],
  ) {
    this.startTime = startTime;
    this.stopTime = stopTime;
    this.primary = primary;
    this.peer = peer;
    this.syncHealthMessageStats = syncHealthMessageStats;
    this.resultsUploadingToPeer = resultsUploadingToPeer;
    this.resultsUploadingToPrimary = resultsUploadingToPrimary;
  }

  results = (who: "Primary" | "Peer") => {
    if (who === "Primary") {
      return this.resultsUploadingToPrimary;
    } else {
      return this.resultsUploadingToPeer;
    }
  };

  errorResults = (who: "Primary" | "Peer") => {
    return this.results(who).filter((result) => {
      return result.isErr();
    });
  };

  errorReasons = (who: "Primary" | "Peer") => {
    const errorReasons = new Set();
    for (const error of this.errorResults(who)) {
      if (error.isErr()) {
        errorReasons.add(error.error.message);
      }
    }
    return [...errorReasons];
  };

  successResults = (who: "Primary" | "Peer") => {
    return this.results(who).filter((result) => {
      return result.isOk();
    });
  };

  successTypes = (who: "Primary" | "Peer") => {
    const successTypes = new Set();
    for (const success of this.successResults(who)) {
      if (success.isOk()) {
        successTypes.add(success.value.data?.userDataBody?.type);
      }
    }
    return [...successTypes];
  };

  serializedSummary = () => {
    return JSON.stringify({
      startTime: new Date(this.startTime),
      stopTime: new Date(this.stopTime),
      primary: this.primary,
      peer: this.peer,
      primaryMessageCount: this.syncHealthMessageStats.primaryNumMessages,
      peerMessageCount: this.syncHealthMessageStats.peerNumMessages,
      diff: this.syncHealthMessageStats.computeDiff(),
      diffPercentage: this.syncHealthMessageStats.computeDiffPercentage(),
      numSuccessToPeer: this.successResults("Peer").length,
      numErrorToPeer: this.errorResults("Peer").length,
      successTypesToPeer: this.successTypes("Peer"),
      errorMessagesToPeer: this.errorReasons("Peer"),
      numSuccessToPrimary: this.successResults("Primary").length,
      numErrorToPrimary: this.errorResults("Primary").length,
      successTypesToPrimary: this.successTypes("Primary"),
      errorMessagesToPrimary: this.errorReasons("Primary"),
    });
  };
}

interface MetadataRetriever {
  getMetadata: (prefix: Buffer) => Promise<HubResult<TrieNodeMetadataResponse>>;
}

const RPC_TIMEOUT_SECONDS = 2;

export class RpcMetadataRetriever implements MetadataRetriever {
  _rpcClient: HubRpcClient;

  constructor(rpcClient: HubRpcClient) {
    this._rpcClient = rpcClient;
  }

  getMetadata = async (prefix: Buffer): Promise<HubResult<TrieNodeMetadataResponse>> => {
    return this._rpcClient.getSyncMetadataByPrefix(TrieNodePrefix.create({ prefix }), new Metadata(), {
      deadline: Date.now() + RPC_TIMEOUT_SECONDS * 1000,
    });
  };
}

export class SyncEngineMetadataRetriever implements MetadataRetriever {
  _syncEngine: SyncEngine;

  constructor(syncEngine: SyncEngine) {
    this._syncEngine = syncEngine;
  }

  getMetadata = async (prefix: Buffer): Promise<HubResult<TrieNodeMetadataResponse>> => {
    const result = await this._syncEngine.getTrieNodeMetadata(prefix);
    if (result) {
      return ok(toTrieNodeMetadataResponse(result));
    } else {
      return err(new HubError("unavailable", "Missing metadata for node"));
    }
  };
}

const getTimePrefix = (time: number) => {
  return toFarcasterTime(time).map((farcasterTime) => {
    console.log("farcaster time", farcasterTime);
    return Buffer.from(timestampToPaddedTimestampPrefix(farcasterTime));
  });
};

const getCommonPrefix = (prefix1: Buffer, prefix2: Buffer): Buffer => {
  const commonPrefix = [];
  for (let i = 0; i < Math.min(prefix1.length, prefix2.length); i++) {
    const startValue = prefix1[i];
    const stopValue = prefix2[i];
    if (startValue !== undefined && startValue === stopValue) {
      commonPrefix.push(startValue);
    } else {
      break;
    }
  }
  return Buffer.from(commonPrefix);
};

const isPrefix = (prefix1: Buffer, prefix2: Buffer): boolean => {
  // This is fine with utf8 encoding because the prefixes are always timestamps
  return prefix1.toString().startsWith(prefix2.toString());
};

const traverseRange = async (
  node: TrieNodeMetadataResponse,
  startTimePrefix: Buffer,
  stopTimePrefix: Buffer,
  metadataRetriever: MetadataRetriever,
  f: (node: TrieNodeMetadataResponse) => undefined,
) => {
  const metadata = await metadataRetriever.getMetadata(Buffer.from(node.prefix));

  if (metadata.isErr()) {
    return err(metadata.error);
  }

  for (const child of metadata.value.children) {
    const childValue = Buffer.from(child.prefix);
    if (Buffer.compare(childValue, startTimePrefix) === 0) {
      f(child);
    } else if (isPrefix(startTimePrefix, childValue) || isPrefix(stopTimePrefix, childValue)) {
      await traverseRange(child, startTimePrefix, stopTimePrefix, metadataRetriever, f);
    } else if (Buffer.compare(childValue, startTimePrefix) === 1 && Buffer.compare(childValue, stopTimePrefix) === -1) {
      f(child);
    }
  }

  return ok(undefined);
};

const getPrefixInfo = async (metadataRetriever: MetadataRetriever, startTime: number, stopTime: number) => {
  const startTimePrefix = getTimePrefix(startTime);
  if (startTimePrefix.isErr()) {
    return err(startTimePrefix.error);
  }

  const stopTimePrefix = getTimePrefix(stopTime);

  if (stopTimePrefix.isErr()) {
    return err(stopTimePrefix.error);
  }

  const commonPrefix = getCommonPrefix(startTimePrefix.value, stopTimePrefix.value);

  console.log(startTimePrefix);
  console.log(stopTimePrefix);
  console.log(commonPrefix);

  const commonPrefixMetadata = await metadataRetriever.getMetadata(Buffer.from(commonPrefix));

  if (commonPrefixMetadata.isErr()) {
    return err(commonPrefixMetadata.error);
  }

  return ok({
    startTimePrefix: startTimePrefix.value,
    stopTimePrefix: stopTimePrefix.value,
    commonPrefixMetadata: commonPrefixMetadata.value,
  });
};

// Queries for the number of messages between the start time and stop time and is efficient with respect to the number of rpcs to the peer. It only queries down along the start prefix and stop prefix starting at the common prefix.

const getNumMessagesInSpanOptimized = async (
  metadataRetriever: MetadataRetriever,
  startTime: number,
  stopTime: number,
) => {
  const prefixInfo = await getPrefixInfo(metadataRetriever, startTime, stopTime);

  if (prefixInfo.isErr()) {
    return err(prefixInfo.error);
  }

  let numMessages = 0;
  const result = await traverseRange(
    prefixInfo.value.commonPrefixMetadata,
    prefixInfo.value.startTimePrefix,
    prefixInfo.value.stopTimePrefix,
    metadataRetriever,
    (node: TrieNodeMetadataResponse) => {
      numMessages += node.numMessages;
    },
  );

  if (result.isErr()) {
    return err(result.error);
  }

  return ok(numMessages);
};

// Queries for the number of messages between the start time and stop time and is very simple. It queries once per second and works if the time span is short.
const getNumMessagesInSpan = async (metadataRetriever: MetadataRetriever, startTime: number, stopTime: number) => {
  let numMessages = 0;

  for (let i = startTime; i < stopTime; i += 1000) {
    const timePrefix = getTimePrefix(i);

    if (timePrefix.isErr()) {
      return err(timePrefix.error);
    }

    const metadata = await metadataRetriever.getMetadata(timePrefix.value);

    if (metadata.isErr()) {
      return err(metadata.error);
    }

    numMessages += metadata.value.numMessages;
  }

  return ok(numMessages);
};

export const computeSyncHealthMessageStats = async (
  startTime: number,
  stopTime: number,
  primaryMetadataRetriever: MetadataRetriever,
  peerMetadataRetriever: MetadataRetriever,
) => {
  const numMessagesPrimary = await getNumMessagesInSpanOptimized(primaryMetadataRetriever, startTime, stopTime);
  const numMessagesPeer = await getNumMessagesInSpanOptimized(peerMetadataRetriever, startTime, stopTime);

  if (numMessagesPrimary.isErr()) {
    return err(numMessagesPrimary.error);
  }

  if (numMessagesPeer.isErr()) {
    return err(numMessagesPeer.error);
  }

  return ok(new SyncHealthMessageStats(numMessagesPrimary.value, numMessagesPeer.value));
};

const pickPeers = async (
  metadataRetriever: RpcMetadataRetriever,
  count: number,
): Promise<HubResult<(string | undefined)[]>> => {
  const peers = await metadataRetriever._rpcClient.getCurrentPeers({});
  return peers.map((peers) => {
    // Shuffle peers then pick [count]
    return peers.contacts
      .map((value) => ({ value, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ value }) => value)
      .slice(0, count)
      .map((peer) => {
        if (peer.rpcAddress) {
          const addrInfo = addressInfoFromGossip(peer.rpcAddress);
          if (addrInfo.isOk()) {
            return addressInfoToString(addrInfo.value);
          }
        }
        return;
      });
  });
};

const computeSyncIdsInSpan = async (
  rpcMetadatataRetriever: RpcMetadataRetriever,
  startTime: number,
  stopTime: number,
) => {
  const prefixInfo = await getPrefixInfo(rpcMetadatataRetriever, startTime, stopTime);

  if (prefixInfo.isErr()) {
    return err(prefixInfo.error);
  }

  const prefixes: Uint8Array[] = [];
  const result = await traverseRange(
    prefixInfo.value.commonPrefixMetadata,
    prefixInfo.value.startTimePrefix,
    prefixInfo.value.stopTimePrefix,
    rpcMetadatataRetriever,
    (node: TrieNodeMetadataResponse) => {
      prefixes.push(node.prefix);
    },
  );

  if (result.isErr()) {
    return err(result.error);
  }

  const syncIds = [];
  for (const prefix of prefixes) {
    const prefixSyncIds = await rpcMetadatataRetriever._rpcClient.getAllSyncIdsByPrefix(
      TrieNodePrefix.create({ prefix }),
    );
    if (prefixSyncIds.isOk()) {
      syncIds.push(...prefixSyncIds.value.syncIds);
    }
  }

  return ok(syncIds);
};

const tryPushingMissingMessages = async (
  rpcClientWithMessages: RpcMetadataRetriever,
  rpcClientMissingMessages: RpcMetadataRetriever,
  missingSyncIds: Buffer[],
) => {
  if (missingSyncIds.length === 0) {
    return ok([]);
  }

  const messages = await rpcClientWithMessages._rpcClient.getAllMessagesBySyncIds({
    syncIds: missingSyncIds,
  });

  if (messages.isErr()) {
    return err(messages.error);
  }

  const results = [];
  for (const message of messages.value.messages) {
    const result = await rpcClientMissingMessages._rpcClient.submitMessage(message);
    results.push(result);
  }

  return ok(results);
};

const uniqueSyncIds = (mySyncIds: Uint8Array[], otherSyncIds: Uint8Array[]) => {
  const idsOnlyInPrimary = [];

  // This is really slow. It's n^2 in the number of sync ids. It seems somwhat complicated to figure out how to hash a sync id or get a string representation that can be hashed.

  for (const syncId of mySyncIds) {
    const syncIdBuffer = Buffer.from(syncId);
    const otherSyncId = otherSyncIds.find((otherSyncId) => {
      const otherSyncIdBuffer = Buffer.from(otherSyncId);
      return Buffer.compare(syncIdBuffer, otherSyncIdBuffer) === 0;
    });

    if (otherSyncId === undefined) {
      idsOnlyInPrimary.push(syncIdBuffer);
    }
  }

  return idsOnlyInPrimary;
};

const investigateDiff = async (
  primaryRpcClient: RpcMetadataRetriever,
  peerRpcClient: RpcMetadataRetriever,
  startTime: number,
  stopTime: number,
) => {
  const primarySyncIds = await computeSyncIdsInSpan(primaryRpcClient, startTime, stopTime);

  if (primarySyncIds.isErr()) {
    return err(primarySyncIds.error);
  }

  const peerSyncIds = await computeSyncIdsInSpan(peerRpcClient, startTime, stopTime);

  if (peerSyncIds.isErr()) {
    return err(peerSyncIds.error);
  }

  const idsOnlyInPrimary = uniqueSyncIds(primarySyncIds.value, peerSyncIds.value);
  const idsOnlyInPeer = uniqueSyncIds(peerSyncIds.value, primarySyncIds.value);

  const resultsPushingToPeer = await tryPushingMissingMessages(primaryRpcClient, peerRpcClient, idsOnlyInPrimary);

  if (resultsPushingToPeer.isErr()) {
    return err(resultsPushingToPeer.error);
  }

  const resultsPushingToPrimary = await tryPushingMissingMessages(peerRpcClient, primaryRpcClient, idsOnlyInPeer);

  if (resultsPushingToPrimary.isErr()) {
    return err(resultsPushingToPrimary.error);
  }

  return ok({
    resultsPushingToPeer: resultsPushingToPeer.value,
    resultsPushingToPrimary: resultsPushingToPrimary.value,
  });
};

const parseTime = (timeString: string) => {
  // Use current date with specified times. Time must be in HH:MM:SS format
  const now = new Date();
  const [hours, minutes, seconds] = timeString.split(":");
  if (hours && minutes && seconds) {
    return now.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds), 0);
  }
  return;
};

export const printSyncHealth = async (
  startTimeOfDay: string,
  stopTimeOfDay: string,
  maxNumPeers: number,
  primaryNode: string,
  outfile: string,
) => {
  const startTime = parseTime(startTimeOfDay);
  const stopTime = parseTime(stopTimeOfDay);

  if (startTime === undefined || stopTime === undefined) {
    console.log("Unable to parse time, must specify as HH:MM:SS");
    return;
  }

  console.log("Start time", new Date(startTime), "Stop time", stopTimeOfDay, new Date(stopTime));

  const primaryRpcClient = getSSLHubRpcClient(primaryNode);

  primaryRpcClient.$.waitForReady(Date.now() + RPC_TIMEOUT_SECONDS * 1000, async (err) => {
    if (err) {
      console.log("Primary rpc client not ready", err);
      throw Error();
    } else {
      const primaryMetadataRetriever = new RpcMetadataRetriever(primaryRpcClient);
      const peers = await pickPeers(primaryMetadataRetriever, maxNumPeers);
      if (peers.isErr()) {
        console.log("Error querying peers");
        return;
      }

      for (const peer of peers.value) {
        if (peer === undefined) {
          continue;
        }
        let peerRpcClient;

        try {
          // Most hubs seem to work with the insecure one
          peerRpcClient = getInsecureHubRpcClient(peer);

          peerRpcClient.$.waitForReady(Date.now() + RPC_TIMEOUT_SECONDS * 1000, (err) => {
            if (err) {
              peerRpcClient = getSSLHubRpcClient(peer);
            }
          });
        } catch (e) {
          peerRpcClient = getSSLHubRpcClient(peer);
        }

        try {
          console.log("Connecting to peer", peer);
          const peerMetadataRetriever = new RpcMetadataRetriever(peerRpcClient);
          const syncHealthStats = await computeSyncHealthMessageStats(
            startTime,
            stopTime,
            primaryMetadataRetriever,
            peerMetadataRetriever,
          );
          if (syncHealthStats.isOk()) {
            // Sync health is us relative to peer. If the sync health is high, means we have more messages. If it's low, we have less.
            const score = syncHealthStats.value.computeDiff();

            // Useful to see progress
            console.log("Computed sync health score", score);

            let aggregateStats;
            if (score !== 0) {
              console.log("Investigating diff");
              const result = await investigateDiff(
                primaryMetadataRetriever,
                peerMetadataRetriever,
                startTime,
                stopTime,
              );

              if (result.isErr()) {
                console.log("Error investigating diff", result.error);
                // Report the stats anyway, but with no investigation results
                aggregateStats = new Stats(startTime, stopTime, primaryNode, peer, syncHealthStats.value, [], []);
              } else {
                aggregateStats = new Stats(
                  startTime,
                  stopTime,
                  primaryNode,
                  peer,
                  syncHealthStats.value,
                  result.value.resultsPushingToPeer,
                  result.value.resultsPushingToPrimary,
                );
              }
            } else {
              // Report the stats anyway, but with no investigation results
              aggregateStats = new Stats(startTime, stopTime, primaryNode, peer, syncHealthStats.value, [], []);
            }

            // The data is valuable, let's just wait to write it. Note, data is appended to any existing file.
            await appendFile(outfile, aggregateStats.serializedSummary());
          } else {
            console.log("Error computing sync health stats", syncHealthStats.error);
          }
          peerRpcClient.close();
        } catch (err) {
          console.log("Rasied while computing sync health", err);
        }
      }
    }

    primaryRpcClient.close();
  });
};
