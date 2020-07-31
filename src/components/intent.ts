/*
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import Bluebird from "bluebird";
import MatrixUser from "../models/users/matrix";
import { ClientRequestCache } from "./client-request-cache";

const MatrixEvent = require("matrix-js-sdk").MatrixEvent;
const RoomMember = require("matrix-js-sdk").RoomMember;

const STATE_EVENT_TYPES = [
    "m.room.name", "m.room.topic", "m.room.power_levels", "m.room.member",
    "m.room.join_rules", "m.room.history_visibility"
];
const DEFAULT_CACHE_TTL = 90000;
const DEFAULT_CACHE_SIZE = 1024;

type MembershipStates = "join"|"leave"|"ban"|"invite"|null;

interface IntentOpts {
    registered: boolean;
    dontCheckPowerLevel: boolean;
    dontJoin: boolean;
    enablePresence?: boolean;
    backingStore: {
        getMembership: (roomId: string, userId: string) => MembershipStates,
        setMembership: (roomId: string, userId: string, membership: MembershipStates) => void,
        getPowerLevelContent: (roomId: string) => any,
        setPowerLevelContent: (roomId: string, content: unknown) => void,
    };
    caching: {
        ttl?: number;
        size?: number;
    }
}

/**
 * Create an entity which can fulfil the intent of a given user.
 * @constructor
 * @param {MatrixClient} client The matrix client instance whose intent is being
 * fulfilled e.g. the entity joining the room when you call intent.join(roomId).
 * @param {MatrixClient} botClient The client instance for the AS bot itself.
 * This will be used to perform more priveleged actions such as creating new
 * rooms, sending invites, etc.
 * @param {Object} opts Options for this Intent instance.
 * @param {boolean} opts.registered True to inform this instance that the client
 * is already registered. No registration requests will be made from this Intent.
 * Default: false.
 * @param {boolean} opts.dontCheckPowerLevel True to not check for the right power
 * level before sending events. Default: false.
 *
 * @param {Object=} opts.backingStore An object with 4 functions, outlined below.
 * If this Object is supplied, ALL 4 functions must be supplied. If this Object
 * is not supplied, the Intent will maintain its own backing store for membership
 * and power levels, which may scale badly for lots of users.
 *
 * @param {Function} opts.backingStore.getMembership A function which is called with a
 * room ID and user ID which should return the membership status of this user as
 * a string e.g "join". `null` should be returned if the membership is unknown.
 *
 * @param {Function} opts.backingStore.getPowerLevelContent A function which is called
 * with a room ID which should return the power level content for this room, as an Object.
 * `null` should be returned if there is no known content.
 *
 * @param {Function} opts.backingStore.setMembership A function with the signature:
 * function(roomId, userId, membership) which will set the membership of the given user in
 * the given room. This has no return value.
 *
 * @param {Function} opts.backingStore.setPowerLevelContent A function with the signature:
 * function(roomId, content) which will set the power level content in the given room.
 * This has no return value.
 *
 * @param {boolean} opts.dontJoin True to not attempt to join a room before
 * sending messages into it. The surrounding code will have to ensure the correct
 * membership state itself in this case. Default: false.
 *
 * @param {boolean} [opts.enablePresence=true] True to send presence, false to no-op.
 *
 * @param {Number} opts.caching.ttl How long requests can stay in the cache, in milliseconds.
 * @param {Number} opts.caching.size How many entries should be kept in the cache, before the oldest is dropped.
 */
export class Intent {
    private opts: IntentOpts;
    private powerLevels: {[roomId: string]: any} = {};
    private membershipStates: {[roomId: string]: MembershipStates} = {};
    private requestCaches: {
        profile: ClientRequestCache<{avatar_url?: string, displayname?: string}>,
        roomstate: ClientRequestCache<unknown>,
        event: ClientRequestCache<unknown>,
    };
    constructor(private client: any, private botClient: any, opts: IntentOpts) {
        opts = opts || {};
        opts.enablePresence = opts.enablePresence !== false;

        if (opts.backingStore) {
            if (!opts.backingStore.setPowerLevelContent ||
                    !opts.backingStore.getPowerLevelContent ||
                    !opts.backingStore.setMembership ||
                    !opts.backingStore.getMembership) {
                throw new Error("Intent backingStore missing required functions");
            }
        }
        else {
            opts.backingStore = {
                getMembership: (roomId, userId) => {
                    if (userId !== this.client.credentials.userId) {
                        return null;
                    }
                    return this.membershipStates[roomId];
                },
                setMembership: (roomId, userId, membership) => {
                    if (userId !== this.client.credentials.userId) {
                        return;
                    }
                    this.membershipStates[roomId] = membership;
                },
                getPowerLevelContent: (roomId: string) => {
                    return this.powerLevels[roomId];
                },
                setPowerLevelContent: (roomId: string, content) => {
                    this.powerLevels[roomId] = content;
                },
            };
        }

        if (!opts.caching) {
            opts.caching = { };
        }

        opts.caching.ttl = opts.caching.ttl === undefined ? DEFAULT_CACHE_TTL : opts.caching.ttl;
        opts.caching.size = opts.caching.size === undefined ? DEFAULT_CACHE_SIZE : opts.caching.ttl;
        this.requestCaches = {
            profile: new ClientRequestCache(
                opts.caching.ttl,
                opts.caching.size,
                (_, userId: string, info: "displayname"|"avatar_url") => {
                    return this.getProfileInfo(userId, info, false);
                }
            ),
            roomstate: new ClientRequestCache(
                opts.caching.ttl,
                opts.caching.size,
                (_, userId, info) => {
                    return this.getProfileInfo(userId, info, false);
                }
            ),
            event: new ClientRequestCache(
                opts.caching.ttl,
                opts.caching.size,
                (_, userId, info) => {
                    return this.getProfileInfo(userId, info, false);
                }
            ),
        };

        this.opts = opts;
    }

    /**
     * Return the client this Intent is acting on behalf of.
     * @return {MatrixClient} The client
     */
    public getClient() {
        return this.client;
    }

    /**
     * <p>Send a plaintext message to a room.</p>
     * This will automatically make the client join the room so they can send the/
     * message if they are not already joined. It will also make sure that the client
     * has sufficient power level to do this.
     * @param {string} roomId The room to send to.
     * @param {string} text The text string to send.
     * @return {Promise}
     */
    public sendText(roomId: string, text: string) {
        return this.sendMessage(roomId, {
            body: text,
            msgtype: "m.text"
        });
    }

    /**
     * <p>Set the name of a room.</p>
     * This will automatically make the client join the room so they can set the
     * name if they are not already joined. It will also make sure that the client
     * has sufficient power level to do this.
     * @param {string} roomId The room to send to.
     * @param {string} name The room name.
     * @return {Promise}
     */
    public setRoomName(roomId: string, name: string) {
        return this.sendStateEvent(roomId, "m.room.name", "", {
            name: name
        });
    }

    /**
     * <p>Set the topic of a room.</p>
     * This will automatically make the client join the room so they can set the
     * topic if they are not already joined. It will also make sure that the client
     * has sufficient power level to do this.
     * @param {string} roomId The room to send to.
     * @param {string} topic The room topic.
     * @return {Promise}
     */
    public setRoomTopic(roomId: string, topic: string) {
        return this.sendStateEvent(roomId, "m.room.topic", "", {
            topic: topic
        });
    }

    /**
     * <p>Set the avatar of a room.</p>
     * This will automatically make the client join the room so they can set the
     * topic if they are not already joined. It will also make sure that the client
     * has sufficient power level to do this.
     * @param {string} roomId The room to send to.
     * @param {string} avatar The url of the avatar.
     * @param {string} info Extra information about the image. See m.room.avatar for details.
     * @return {Promise}
     */
    public setRoomAvatar(roomId: string, avatar: string, info: object) {
        const content: { url: string, info?: object} = {
            url: avatar,
        }
        if (info) {
            content.info = info;
        }
        return this.sendStateEvent(roomId, "m.room.avatar", "", content);
    }

    /**
     * <p>Send a typing event to a room.</p>
     * This will automatically make the client join the room so they can send the
     * typing event if they are not already joined.
     * @param {string} roomId The room to send to.
     * @param {boolean} isTyping True if typing
     * @return {Promise}
     */
    public sendTyping(roomId: string, isTyping: boolean) {
        const self = this;
        return self._ensureJoined(roomId).then(function() {
            return self._ensureHasPowerLevelFor(roomId, "m.typing");
        }).then(function() {
            return self.client.sendTyping(roomId, isTyping);
        });
    }

    /**
     * <p>Send a read receipt to a room.</p>
     * This will automatically make the client join the room so they can send the
     * receipt event if they are not already joined.
     * @param{string} roomId The room to send to.
     * @param{string} eventId The event ID to set the receipt mark to.
     * @return {Promise}
     */
    public sendReadReceipt(roomId: string, eventId: string) {
        const self = this;
        const event = new MatrixEvent({
            room_id: roomId,
            event_id: eventId,
        });
        return self._ensureJoined(roomId).then(function() {
            return self.client.sendReadReceipt(event);
        });
    }

    /**
     * Set the power level of the given target.
     * @param {string} roomId The room to set the power level in.
     * @param {string} target The target user ID
     * @param {number} level The desired level
     * @return {Promise}
     */
    public setPowerLevel(roomId: string, target: string, level: number) {
        const self = this;
        return self._ensureJoined(roomId).then(function() {
            return self._ensureHasPowerLevelFor(roomId, "m.room.power_levels");
        }).then(function(event) {
            return self.client.setPowerLevel(roomId, target, level, event);
        });
    }

    /**
     * <p>Send an <code>m.room.message</code> event to a room.</p>
     * This will automatically make the client join the room so they can send the
     * message if they are not already joined. It will also make sure that the client
     * has sufficient power level to do this.
     * @param {string} roomId The room to send to.
     * @param {Object} content The event content
     * @return {Promise}
     */
    public sendMessage(roomId: string, content: object) {
        return this.sendEvent(roomId, "m.room.message", content);
    }

    /**
     * <p>Send a message event to a room.</p>
     * This will automatically make the client join the room so they can send the
     * message if they are not already joined. It will also make sure that the client
     * has sufficient power level to do this.
     * @param {string} roomId The room to send to.
     * @param {string} type The event type
     * @param {Object} content The event content
     * @return {Promise}
     */
    public sendEvent(roomId: string, type: string, content: object) {
        const self = this;
        return self._ensureJoined(roomId).then(function() {
            return self._ensureHasPowerLevelFor(roomId, type);
        }).then(self._joinGuard(roomId, function() {
            return self.client.sendEvent(roomId, type, content);
        }));
    }

    /**
     * <p>Send a state event to a room.</p>
     * This will automatically make the client join the room so they can send the
     * state if they are not already joined. It will also make sure that the client
     * has sufficient power level to do this.
     * @param {string} roomId The room to send to.
     * @param {string} type The event type
     * @param {string} skey The state key
     * @param {Object} content The event content
     * @return {Promise}
     */
    public sendStateEvent(roomId: string, type: string, skey: string, content: object) {
        const self = this;
        return self._ensureJoined(roomId).then(function() {
            return self._ensureHasPowerLevelFor(roomId, type);
        }).then(self._joinGuard(roomId, function() {
            return self.client.sendStateEvent(roomId, type, content, skey);
        }));
    }

    /**
     * <p>Get the current room state for a room.</p>
     * This will automatically make the client join the room so they can get the
     * state if they are not already joined.
     * @param {string} roomId The room to get the state from.
     * @param {boolean} [useCache=false] Should the request attempt to lookup
     * state from the cache.
     * @return {Promise}
     */
    public roomState(roomId: string, useCache=false) {
        return this._ensureJoined(roomId).then(() => {
            if (useCache) {
                return this.requestCaches.roomstate.get(roomId);
            }
            return this.client.roomState(roomId);
        });
    }

    /**
     * Create a room with a set of options.
     * @param {Object} opts Options.
     * @param {boolean} opts.createAsClient True to create this room as a client and
     * not the bot: the bot will not join. False to create this room as the bot and
     * auto-join the client. Default: false.
     * @param {Object} opts.options Options to pass to the client SDK /createRoom API.
     * @return {Promise}
     */
    public createRoom(opts: {createAsClient: boolean, options: {invite?: string[]}}) {
        const self = this;
        const cli = opts.createAsClient ? this.client : this.botClient;
        const options = opts.options || {};
        if (!opts.createAsClient) {
            // invite the client if they aren't already
            options.invite = options.invite || [];
            if (options.invite.indexOf(this.client.credentials.userId) === -1) {
                options.invite.push(this.client.credentials.userId);
            }
        }
        // make sure that the thing doing the room creation isn't inviting itself
        // else Synapse hard fails the operation with M_FORBIDDEN
        if (options.invite && options.invite.indexOf(cli.credentials.userId) !== -1) {
            options.invite.splice(options.invite.indexOf(cli.credentials.userId), 1);
        }

        return this._ensureRegistered().then(function() {
            return cli.createRoom(options);
        }).then(function(res) {
            // create a fake power level event to give the room creator ops if we
            // don't yet have a power level event.
            if (self.opts.backingStore.getPowerLevelContent(res.room_id)) {
                return res;
            }
            self.opts.backingStore.setPowerLevelContent(res.room_id, {
                users_default: 0,
                events_default: 0,
                state_default: 50,
                users: { [cli.credentials.userId]: 100},
                events: {}
            });
            return res;
        });
    }

    /**
     * <p>Invite a user to a room.</p>
     * This will automatically make the client join the room so they can send the
     * invite if they are not already joined.
     * @param {string} roomId The room to invite the user to.
     * @param {string} target The user ID to invite.
     * @return {Promise} Resolved when invited, else rejected with an error.
     */
    public invite(roomId: string, target: string) {
        const self = this;
        return this._ensureJoined(roomId).then(function() {
            return self.client.invite(roomId, target);
        });
    }

    /**
     * <p>Kick a user from a room.</p>
     * This will automatically make the client join the room so they can send the
     * kick if they are not already joined.
     * @param {string} roomId The room to kick the user from.
     * @param {string} target The target of the kick operation.
     * @param {string} reason Optional. The reason for the kick.
     * @return {Promise} Resolved when kickked, else rejected with an error.
     */
    public kick(roomId: string, target: string, reason?: string) {
        const self = this;
        return this._ensureJoined(roomId).then(function() {
            return self.client.kick(roomId, target, reason);
        });
    }

    /**
     * <p>Ban a user from a room.</p>
     * This will automatically make the client join the room so they can send the
     * ban if they are not already joined.
     * @param {string} roomId The room to ban the user from.
     * @param {string} target The target of the ban operation.
     * @param {string} reason Optional. The reason for the ban.
     * @return {Promise} Resolved when banned, else rejected with an error.
     */
    public ban(roomId: string, target: string, reason?: string) {
        const self = this;
        return this._ensureJoined(roomId).then(function() {
            return self.client.ban(roomId, target, reason);
        });
    }

    /**
     * <p>Unban a user from a room.</p>
     * This will automatically make the client join the room so they can send the
     * unban if they are not already joined.
     * @param {string} roomId The room to unban the user from.
     * @param {string} target The target of the unban operation.
     * @return {Promise} Resolved when unbanned, else rejected with an error.
     */
    public unban(roomId: string, target: string) {
        const self = this;
        return this._ensureJoined(roomId).then(function() {
            return self.client.unban(roomId, target);
        });
    }

    /**
     * <p>Join a room</p>
     * This will automatically send an invite from the bot if it is an invite-only
     * room, which may make the bot attempt to join the room if it isn't already.
     * @param {string} roomId The room to join.
     * @param {string[]} viaServers The server names to try and join through in
     * addition to those that are automatically chosen.
     * @return {Promise}
     */
    public join(roomId: string, viaServers: string[]) {
        return this._ensureJoined(roomId, false, viaServers);
    }

    /**
     * <p>Leave a room</p>
     * This will no-op if the user isn't in the room.
     * @param {string} roomId The room to leave.
     * @return {Promise}
     */
    public leave(roomId: string) {
        return this.client.leave(roomId);
    }

    /**
     * <p>Get a user's profile information</p>
     * @param {string} userId The ID of the user whose profile to return
     * @param {string} info The profile field name to retrieve (e.g. 'displayname'
     * or 'avatar_url'), or null to fetch the entire profile information.
     * @param {boolean} [useCache=true] Should the request attempt to lookup
     * state from the cache.
     * @return {Promise} A Promise that resolves with the requested user's profile
     * information
     */
    public getProfileInfo(userId: string, info?: "displayname"|"avatar_url"|null, useCache=true): Bluebird<{avatar_url?: string, displayname?: string}> {
        return this._ensureRegistered().then(() => {
            if (useCache) {
                return this.requestCaches.profile.get(`${userId}:${info}`, userId, info);
            }
            return this.client.getProfileInfo(userId, info);
        });
    }

    /**
     * <p>Set the user's display name</p>
     * @param {string} name The new display name
     * @return {Promise}
     */
    public setDisplayName(name: string) {
        const self = this;
        return self._ensureRegistered().then(function() {
            return self.client.setDisplayName(name);
        });
    }

    /**
     * <p>Set the user's avatar URL</p>
     * @param {string} url The new avatar URL
     * @return {Promise}
     */
    public setAvatarUrl(url: string) {
        const self = this;
        return self._ensureRegistered().then(function() {
            return self.client.setAvatarUrl(url);
        });
    }

    /**
     * Create a new alias mapping.
     * @param {string} alias The room alias to create
     * @param {string} roomId The room ID the alias should point at.
     * @return {Promise}
     */
    public createAlias(alias:string, roomId: string) {
        const self = this;
        return self._ensureRegistered().then(function() {
            return self.client.createAlias(alias, roomId);
        });
    }

    /**
     * Set the presence of this user.
     * @param {string} presence One of "online", "offline" or "unavailable".
     * @param {string} status_msg The status message to attach.
     * @return {Promise} Resolves if the presence was set or no-oped, rejects otherwise.
     */
    public setPresence(presence: "online"|"offline"|"unavailable", status_msg?: string) {
        if (!this.opts.enablePresence) {
            return Bluebird.resolve();
        }

        return this._ensureRegistered().then(() => {
            return this.client.setPresence({presence, status_msg});
        });
    }

    /**
     * @typedef {
     *       "m.event_not_handled"
     *     | "m.event_too_old"
     *     | "m.internal_error"
     *     | "m.foreign_network_error"
     *     | "m.event_unknown"
     * } BridgeErrorReason
     */

    /**
     * Signals that an error occured while handling an event by the bridge.
     *
     * **Warning**: This function is unstable and is likely to change pending the outcome
     * of https://github.com/matrix-org/matrix-doc/pull/2162.
     * @param {string} roomID ID of the room in which the error occured.
     * @param {string} eventID ID of the event for which the error occured.
     * @param {string} networkName Name of the bridged network.
     * @param {BridgeErrorReason} reason The reason why the bridge error occured.
     * @param {string} reason_body A human readable string d
     * @param {string[]} affectedUsers Array of regex matching all affected users.
     * @return {Promise}
     */
    public unstableSignalBridgeError(
        roomID: string,
        eventID: string,
        networkName: string,
        reason: string,
        affectedUsers: string[]
    ) {
        return this.sendEvent(
            roomID,
            "de.nasnotfound.bridge_error",
            {
                network_name: networkName,
                reason: reason,
                affected_users: affectedUsers,
                "m.relates_to": {
                    rel_type: "m.reference",
                    event_id: eventID,
                },
            }
        );
    }

    /**
     * Get an event in a room.
     * This will automatically make the client join the room so they can get the
     * event if they are not already joined.
     * @param {string} roomId The room to fetch the event from.
     * @param {string} eventId The eventId of the event to fetch.
     * @param {boolean} [useCache=true] Should the request attempt to lookup from the cache.
     * @return {Promise} Resolves with the content of the event, or rejects if not found.
     */
    public getEvent(roomId: string, eventId: string, useCache=true) {
        return this._ensureRegistered().then(() => {
            if (useCache) {
                return this.requestCaches.event.get(`${roomId}:${eventId}`, roomId, eventId);
            }
            return this.client.fetchRoomEvent(roomId, eventId);
        });
    }

    /**
     * Get a state event in a room.
     * This will automatically make the client join the room so they can get the
     * state if they are not already joined.
     * @param {string} roomId The room to get the state from.
     * @param {string} eventType The event type to fetch.
     * @param {string} [stateKey=""] The state key of the event to fetch.
     * @return {Promise}
     */
    public getStateEvent(roomId: string, eventType: string, stateKey = "") {
        return this._ensureJoined(roomId).then(() => {
            return this.client.getStateEvent(roomId, eventType, stateKey);
        });
    }

    /**
     * Inform this Intent class of an incoming event. Various optimisations will be
     * done if this is provided. For example, a /join request won't be sent out if
     * it knows you've already been joined to the room. This function does nothing
     * if a backing store was provided to the Intent.
     * @param {Object} event The incoming event JSON
     */
    public onEvent(event: {type: string, state_key: string, room_id: string, content: { membership?: MembershipStates}}) {
        if (!this.membershipStates || !this.powerLevels) {
            return;
        }
        if (event.type === "m.room.member" &&
                event.state_key === this.client.credentials.userId && event.content.membership) {
            this.membershipStates[event.room_id] = event.content.membership;
        }
        else if (event.type === "m.room.power_levels") {
            this.powerLevels[event.room_id] = event.content;
        }
    }

    // Guard a function which returns a promise which may reject if the user is not
    // in the room. If the promise rejects, join the room and retry the function.
    private _joinGuard<T>(roomId: string, promiseFn: () => Promise<T>) {
        const self = this;
        return function() {
            return promiseFn().catch(function(err) {
                if (err.errcode !== "M_FORBIDDEN") {
                    // not a guardable error
                    throw err;
                }
                return self._ensureJoined(roomId, true).then(function() {
                    return promiseFn();
                })
            });
        }
    }

    private async _ensureJoined(
        roomId: string, ignoreCache = false, viaServers?: string[], passthroughError = false
    ) {
        const userId = this.client.credentials.userId;
        const opts: {syncRoom: false, viaServers?: string[]} = {
            syncRoom: false,
        }
        if (viaServers) {
            opts.viaServers = viaServers;
        }
        if (this.opts.backingStore.getMembership(roomId, userId) === "join" && !ignoreCache) {
            return Bluebird.resolve();
        }

        /* Logic:
        if client /join:
        SUCCESS
        else if bot /invite client:
        if client /join:
            SUCCESS
        else:
            FAIL (client couldn't join)
        else if bot /join:
        if bot /invite client and client /join:
            SUCCESS
        else:
            FAIL (bot couldn't invite)
        else:
        FAIL (bot can't get into the room)
        */

        const deferredPromise = Bluebird.defer();

        const mark = (r: string, state: MembershipStates) => {
            this.opts.backingStore.setMembership(r, userId, state);
            if (state === "join") {
                deferredPromise.resolve();
            }
        }

        const dontJoin = this.opts.dontJoin;

        try {
            await this._ensureRegistered();
            if (dontJoin) {
                deferredPromise.resolve();
                return deferredPromise.promise;
            }
            try {
                await this.client.joinRoom(roomId, opts);
                mark(roomId, "join");
            }
            catch (ex) {
                if (ex.errcode !== "M_FORBIDDEN" || this.botClient === this) {
                    throw ex;
                }
                try {
                    // Try bot inviting client
                    await this.botClient.invite(roomId, userId);
                    await this.client.joinRoom(roomId, opts);
                    mark(roomId, "join");
                }
                catch (_ex) {
                    // Try bot joining
                    await this.botClient.joinRoom(roomId, opts)
                    await this.botClient.invite(roomId, userId);
                    await this.client.joinRoom(roomId, opts);
                    mark(roomId, "join");
                }
            }
        }
        catch (ex) {
            deferredPromise.reject(passthroughError ? ex : Error("Failed to join room"));
        }

        return deferredPromise.promise;
    }

    private _ensureHasPowerLevelFor(roomId: string, eventType: string) {
        if (this.opts.dontCheckPowerLevel && eventType !== "m.room.power_levels") {
            return Bluebird.resolve();
        }
        const self = this;
        const userId = this.client.credentials.userId;
        const plContent = this.opts.backingStore.getPowerLevelContent(roomId);
        let promise = Bluebird.resolve(plContent);
        if (!plContent) {
            promise = this.client.getStateEvent(roomId, "m.room.power_levels", "");
        }
        return promise.then(function(eventContent) {
            self.opts.backingStore.setPowerLevelContent(roomId, eventContent);
            const event = {
                content: eventContent,
                room_id: roomId,
                sender: "",
                event_id: "_",
                state_key: "",
                type: "m.room.power_levels"
            }
            const powerLevelEvent = new MatrixEvent(event);
            // What level do we need for this event type?
            let defaultLevel = event.content.events_default;
            if (STATE_EVENT_TYPES.indexOf(eventType) !== -1) {
                defaultLevel = event.content.state_default;
            }
            const requiredLevel = event.content.events[eventType] || defaultLevel;

            // Parse out what level the client has by abusing the JS SDK
            const roomMember = new RoomMember(roomId, userId);
            roomMember.setPowerLevelEvent(powerLevelEvent);

            if (requiredLevel > roomMember.powerLevel) {
                // can the bot update our power level?
                const bot = new RoomMember(roomId, self.botClient.credentials.userId);
                bot.setPowerLevelEvent(powerLevelEvent);
                const levelRequiredToModifyPowerLevels = event.content.events[
                    "m.room.power_levels"
                ] || event.content.state_default;
                if (levelRequiredToModifyPowerLevels > bot.powerLevel) {
                    // even the bot has no power here.. give up.
                    throw new Error(
                        "Cannot ensure client has power level for event " + eventType +
                        " : client has " + roomMember.powerLevel + " and we require " +
                        requiredLevel + " and the bot doesn't have permission to " +
                        "edit the client's power level."
                    );
                }
                // update the client's power level first
                return self.botClient.setPowerLevel(
                    roomId, userId, requiredLevel, powerLevelEvent
                ).then(function() {
                    // tweak the level for the client to reflect the new reality
                    const userLevels = powerLevelEvent.getContent().users || {};
                    userLevels[userId] = requiredLevel;
                    powerLevelEvent.getContent().users = userLevels;
                    return Bluebird.resolve(powerLevelEvent);
                });
            }
            return Bluebird.resolve(powerLevelEvent);
        });
    }

    private _ensureRegistered(): Bluebird<unknown> {
        if (this.opts.registered) {
            return Bluebird.resolve("registered=true");
        }
        const userId = this.client.credentials.userId;
        const localpart = new MatrixUser(userId).localpart;
        return this.botClient.register(localpart).then((res: unknown) => {
            this.opts.registered = true;
            return res;
        }).catch((err: {errcode: string}) => {
            if (err.errcode === "M_USER_IN_USE") {
                this.opts.registered = true;
                return null;
            }
            throw err;
        });
    }
}