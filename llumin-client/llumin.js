import axios from 'axios';
import store from '../renderer/store';
const signalr = require('node-signalr');
const EventEmitter = require('events');

// LLumin Rest API
class LLuminApi extends EventEmitter  {
    constructor(lluminUrl, username, password, options) {
        super();
        this.lluminUrl = lluminUrl;
        this.lluminUrl += lluminUrl.endsWith('/') ? '' : '/';
        this.username = username;
        this.password = password;
        this.lluminServiceName = options.lluminServiceName ||  'LLuminMachineInterface';
        this.signalRPaused = options.signalRPaused ||  false;
        this.accessToken = null;
        this.accessTokenExpiration = 0;
        this.headers = {'Content-Type': 'application/json'};
        this.gettingToken = false;
        this.axios = axios.create({});

        // Update status
        this.updateStatus = "UPDATE_LLUMIN_STATUS";
        if (options.secondary) {
            this.updateStatus = "UPDATE_LLUMIN_STATUS2";
        }

        // Initialize SignalR client.
        this.signalRUrl = this.lluminUrl + 'signalr';
        this.signalRConnecting = false;
        store.dispatch(this.updateStatus, 'disconnected');
        this.hubName = 'machineInterfaceHub';
        this.hub = null;
        this.signalRClient = new signalr.client(
            this.signalRUrl,
            [this.hubName]
        );
        // Custom headers
        this.signalRClient.end();
        this.signalRClient.headers['LLuminAuth'] = this.accessToken;
        this.signalRClient.headers['LLuminService'] = this.lluminServiceName;
        // Initialize signalR callbacks
        this.signalRClient.on('connected', () => {
            this.signalRConnecting = false;
            store.dispatch(this.updateStatus, 'connected');
            console.log('SignalR client connected.')
        });
        this.signalRClient.on('reconnecting', (count) => {
            console.log(`SignalR client reconnecting(${count}).`);
            store.dispatch(this.updateStatus, `reconnecting(${count})`);
        });
        this.signalRClient.on('disconnected', (code) => {
            console.log(`SignalR client disconnected(${code}).`);
            store.dispatch(this.updateStatus, `disconnected(${code})`);
        });
        this.signalRClient.on('error', (code) => {
            console.log(`SignalR client error: ${code}.`);
            store.dispatch(this.updateStatus, `error(${code})`);
            if (code === "Unauthorized") this.accessTokenExpiration = 0;
            this.signalRConnecting = false;
            this.connectSignalR();
        });
        this.signalRClient.connection.hub.on(this.hubName, 'echo', this._receiveMessage);
        this.signalRClient.connection.hub.on(this.hubName, 'pause', () => {
            console.log('Got pause');
            store.dispatch(this.updateStatus, 'paused');
            this.signalRPaused = true;
        });
        this.signalRClient.connection.hub.on(this.hubName, 'resume', () => {
            console.log('Got resume');
            store.dispatch(this.updateStatus, 'connected');
            this.signalRPaused = false;
        });
        this.signalRClient.connection.hub.on(this.hubName, 'tagsLoaded', () => this._tagsLoaded());
    }

    until(conditionFunction) {
        const poll = resolve => {
            if(conditionFunction()) resolve();
            else setTimeout(_ => poll(resolve), 500);
        };

        return new Promise(poll);
    }

    async getAccessToken() {
        try {
            // If currently getting a token, then wait for it
            await this.until(_ => this.gettingToken === false);
            let now = new Date();
            if (now.getTime() < this.accessTokenExpiration) {
                return;
            }

            this.gettingToken = true;
            console.log('LLumin Access Token expired, get new one');
            let result = await this.axios.request({
                url: this.lluminUrl + "api/GetToken",
                method: 'POST',
                data: {'username': this.username, 'password': this.password},
                headers: this.headers
            });
            this.gettingToken = false;
            this.accessToken = result.data;
            now = new Date();
            this.accessTokenExpiration = now.getTime() + (60*60*1000);
            this.headers.LLuminAuth = this.accessToken;
            this.signalRClient.headers['LLuminAuth'] =  this.accessToken;
            console.log("LLumin access token: ", this.accessToken);
        }
        catch (e) {
            console.error('access token error: ', e.message);
        }
    }

    async getServers() {
        await this.getAccessToken();
        console.log('Getting server list from LLumin server');
        return this.axios.request({
            url: this.lluminUrl + "api/MachineInterface/GetServers",
            method: 'GET',
            headers: this.headers
        })
            .then(result => {
                let results = [];
                if (!(result.data instanceof Array)) {
                    console.error('GetServers result.data not an array: ', result)
                }
                result.data.forEach((element) => {
                    results.push({
                        id: element.ServerId,
                        name: element.ServerName,
                        url: element.ConnectionUrl,
                        protocol: element.Protocol,
                        connectionData: element.ConnectionData,
                        isInactive: element.IsInactive
                    });
                });
                return results;
            })
            .catch(e => console.error('get servers error: ', e.message));
    }

    async addServer(newServer) {
        await this.getAccessToken();
        console.log(`Adding OPC server to LLumin: ${newServer.name}`);
        newServer.isInactive = false;
        return this.axios.request({
            url: this.lluminUrl + "api/MachineInterface/AddServer",
            method: 'POST',
            data: {
                ServerName: newServer.name,
                ConnectionUrl: newServer.url,
                Protocol: newServer.protocol,
                ConnectionData: '',
                IsInactive: newServer.isInactive
            },
            headers: this.headers
        })
            .then(result => {
                newServer.id = result.data.Id;
                return newServer;
            })
            .catch(e => console.error('add server error: ', e.message));
    }

    async updateServer(server) {
        await this.getAccessToken();
        console.log(`Updating server on LLumin: ${server.name}`);
        return this.axios.request({
            url: this.lluminUrl + "api/MachineInterface/UpdateServer",
            method: 'PUT',
            data: {
                ServerId: server.id,
                ServerName: server.name,
                ConnectionUrl: server.url,
                Protocol: server.protocol,
                ConnectionData: '',
                IsInactive: server.isInactive
            },
            headers: this.headers
        })
            .then(_ => {
                store.dispatch("UPDATE_CONNECTION", server);
                return server
            })
            .catch(e => console.error('update server error: ',  e.message));
    }

    async deleteServer(server) {
        await this.getAccessToken();
        console.log(`Deleting server on LLumin: ${server.name}`);
        return this.axios.request({
            url: this.lluminUrl + "api/MachineInterface/DeleteServer",
            method: 'POST',
            data: {
                ServerId: server.id,
            },
            headers: this.headers
        })
            .then(_ => server)
            .catch(e => console.error('update server error: ', e.message));
    }

    async getTags() {
        await this.getAccessToken();
        console.log('Getting tags to monitor from LLumin');
        return this.axios.request({
            url: this.lluminUrl + "api/MachineInterface/GetTags",
            method: 'GET',
            headers: this.headers
        })
            .then(result => result.data)
            .catch(e => console.error('get tags error: ', e.message));
    }

    async addTag(tag) {
        await this.getAccessToken();
        console.log(`Adding tag to monitor to LLumin: ${tag.nodeId}`);
        return this.axios.request({
            url: this.lluminUrl + "api/MachineInterface/AddTag",
            method: 'POST',
            data: {
                'ServerId': tag.serverId,
                'TagName': tag.nodeId,
                'AssetCode': tag.assetCode,
                'DataType': tag.dataType,
                // 'Attributes': tag.attributes
            },
            headers: this.headers
        })
            .then(result => {
                tag.id = result.data.Id;
                return tag;
            })
            .catch(e => console.error('add tag error: ', e.message));
    }

    async removeTag(id) {
        await this.getAccessToken();
        console.log(`Removing tag to monitor from LLumin: ${id}`);
        return this.axios.request({
            url: this.lluminUrl + "api/MachineInterface/RemoveTag",
            method: 'POST',
            data: {'Id': id},
            headers: this.headers
        })
            .then(result => result.data)
            .catch(e => console.error('remove tag error: ', e.message));
    }

    async getAsset(text) {
        await this.getAccessToken();
        console.log('Getting LLumin asset info');
        return this.axios.request({
            url: this.lluminUrl + "api/Asset/Search",
            method: 'GET',
            params: {
                text: text,
                exactMatch: false,
                pageSize: 100
            },
            headers: this.headers
        })
            // Returns:
            //     [{
            //         "AssetCode": string,
            //         "Description": string,
            //         "ParentAssetCode": string,
            //         "DivisionId": string,
            //         "EquipmentId": string,
            //         "IsInactive": bool
            //     }]
            .then(result => result.data)
            .catch(e => console.error('get llumin asset error: ', e.message));
    }

    //
    // SignalR Methods
    //

    async connectSignalR() {
        try {
            await this.getAccessToken();
            if (this.signalRConnecting) {
                await this.until(_ => this.signalRConnecting === false);
                return;
            }

            if (this.signalRClient.connection.state === signalr.connectionState.disconnected) {
                // Start SignalR client
                this.signalRConnecting = true;
                this.signalRClient.start();
            }
        } catch (e) {
            console.error('SignalR connection error: ', e);
        }
    }

    _receiveMessage(message) {
        console.debug("signalr received => ", JSON.stringify(message));
    }

    _tagsLoaded() {
        console.debug("signalr received tagsLoaded signal");
        console.log(this.emit('reloadTags'));
    }

    async sendMessage(message) {
        await this.connectSignalR();
        console.debug('signalr sending: ', message);
        this.hub.call('SendMessage', message)
            .done(function (err, result) {
                if (!err)  {
                    console.debug("SendMessage returned: ", result);
                }
            });
    }

    async updateTagValue(data) {
        if (this.signalRPaused) {
            console.debug('SignalR paused');
            return;
        }
        await this.connectSignalR();
        console.debug(`SignalR updating tag ${data.id} : ${data.value}`);
        this.signalRClient.connection.hub.invoke(
            this.hubName,
            'UpdateTagValue',
            {
                'Id': data.id,
                'DateUpdated': data.dateUpdated,
                'Value': data.value,
                'Quality': data.quality
            }
        );
    }
}

export default LLuminApi;
