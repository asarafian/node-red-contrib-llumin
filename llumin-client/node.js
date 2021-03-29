module.exports = function(RED) {
    "use strict";
    const LLuminApi = require("./llumin");

    function LluminClient(config) {
        RED.nodes.createNode(this, config);
        let node = this;

        node.url = config.url;
        node.username = config.username;
        node.password = config.password;
        node.password = config.password;
        node.lluminServiceName = config.lluminServiceName;
        node.lluminSignalRPaused = false;
        node.tagsToMonitor = [];
        node.server = {
            id: 1
        }

        function connectToLLumin() {
            // Disconnect from signalR if already connected.
            try {
                node.lluminApi.signalRclient.end();
            } catch (e) {}

            // Create primary LLumin instance
            node.lluminApi = new LLuminApi(node.url, node.username, node.password, {
                lluminServiceName: node.lluminServiceName,
                lluminSignalRPaused: node.lluminSignalRPaused,
                secondary: false,
                node: node
            });
            node.lluminApi.on('reloadTags', function () {
            });
        }

        try {
            connectToLLumin();

            node.lluminApi.getTags().then(async (response) => {
                response.forEach((tag) => {
                    if (tag.ServerId === node.server.id) {
                        node.tagsToMonitor.push({
                            id: tag.Id,
                            nodeId: tag.TagName
                        });
                    }
                });
            });
        } catch (e) { console.error('Problem connecting with LLumin server: ', e); }

        node.on('input', async function(msg, send, done) {
            send = send || function() { node.send.apply(node,arguments) }
            let topic = msg.topic;
            let payload = msg.payload;
            let quality = msg.quality || '';
            let timestamp;
            if (msg.timestamp) {
                timestamp = new Date(msg.timestamp);
            }
            let description = msg.description || '';
            if (!topic) {
                node.error('Missing msg.topic');
                if (done) done();
                return;
            }
            if (!payload) {
                node.error('Missing msg.payload');
                if (done) done();
                return;
            }
            // if (!Array.isArray(payload)) {
            //     node.error('msg.payload must be an array');
            //     if (done) done();
            //     return;
            // }

            try {
                // Are we monitoring this topic already?
                let tag = node.tagsToMonitor.find(x => x.nodeId === topic);
                if (tag === undefined) {
                    // Add topic to LLumin server
                    console.log(`Adding new tag to LLumin to monitor: ${topic}`);
                    let attributes = '';
                    if (description) {
                        attributes = {
                            'description': description
                        };
                    }
                    const response = await node.lluminApi.addTag({
                        serverId: node.server.id,
                        nodeId: topic,
                        assetCode: '',
                        dataType: '',
                        attributes: attributes
                    });
                    if (response.id === undefined) return;
                    tag = {
                        id: response.id,
                        nodeId: topic
                    };
                    node.tagsToMonitor.push(tag);
                }

                console.log("Updating tag value.");
                if (tag.value === payload && tag.timestamp === timestamp && tag.quality === quality) {
                    return;
                }
                tag.value = payload;
                tag.quality = quality;
                tag.timestamp = timestamp;

                const response = await node.lluminApi.updateTagValue({
                    'id': tag.id,
                    'dateUpdated': tag.timestamp,
                    'value': tag.value,
                    'quality': tag.quality
                });
            } catch (e) {}

            msg = {};
            msg.payload = response;
            node.send(msg);

            // if (err) {
            //     if (done) done(err);
            //     else node.error(err, msg);
            // }
            if (done) done();
        });

        node.on("close", function (done) {
            try {
                node.lluminApi.signalRClient.end();
                node.lluminApi2.signalRClient.end();
            } catch(e) {}
            node.status({});
            if (done) done();
        });
    }

    RED.nodes.registerType("llumin-client",LluminClient);
}