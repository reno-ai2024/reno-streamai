import fetch from 'node-fetch';
import WebSocket from 'ws';
import log from './logger.js';
import { SocksProxyAgent } from 'socks-proxy-agent';

class Task {
    constructor(taskid, method, url, headers, body, script, debug, timeout, gateway, proxy = null) {
        this.taskid = taskid;
        this.controller = new AbortController();
        this.born = Date.now();
        this.timeout = timeout;
        this.gateway = gateway;

        const fetchOptions = {
            signal: this.controller.signal,
            method,
            headers,
        };

        if (proxy) {
            fetchOptions.agent = new SocksProxyAgent(proxy);
        }

        if (body && method === "POST") {
            fetchOptions.body = body;
        }

        this.task = fetch(url, fetchOptions)
            .then(async (response) => {
                const responseText = await response.text();
                log.info(`Response: ${responseText}`);

                if (script) {
                    await GlobalExecutor.execute(script, responseText, this.timeout);
                }

                if (response.ok) {
                    this.gateway.transferResult(taskid, responseText, response.status);
                } else {
                    throw new Error(`Failed with status: ${response.status}`);
                }
            })
            .catch((error) => {
                log.error(`Task ${taskid} failed: ${error.message}`);
                this.gateway.transferError(taskid, error.message, error.code || 500);
            })
            .finally(() => {
                log.info(`Task ${taskid} completed`);
            });
    }

    cancel() {
        this.controller.abort();
    }
}

class Gateway {
    constructor(server, user, dev, proxy = null) {
        this.server = server;
        this.user = user;
        this.dev = dev;
        this.proxy = proxy;
        this.isConnected = false;

        const wsOptions = {};

        if (this.proxy) {
            try {
                wsOptions.agent = new SocksProxyAgent(proxy);
            } catch (error) {
                log.error(`Invalid proxy format: ${proxy}`);
                throw error;
            }
        }

        this.ws = new WebSocket(`wss://${server}/connect`, wsOptions);
        this._setupWebSocket();
    }

    _setupWebSocket() {
        this.ws.on("open", () => {
            log.info("Gateway connected.");
            this.isConnected = true;
            this._startPingInterval();
            this.sendMessage(
                JSON.stringify({
                    type: "register",
                    user: this.user,
                    dev: this.dev,
                })
            );
        });

        this.ws.on("message", (data) => {
            log.info(`Message received: ${data}`);
        });

        this.ws.on("close", () => {
            log.info("Gateway disconnected.");
            this.isConnected = false;
        });

        this.ws.on("error", (error) => {
            log.error(`WebSocket error: ${error.message}`);
        });
    }

    sendMessage(message) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(message);
        } else {
            log.warn("WebSocket not open; retrying...");
            setTimeout(() => this.sendMessage(message), 1000);
        }
    }

    _startPingInterval() {
        setInterval(() => {
            if (this.isConnected) {
                this.sendMessage(JSON.stringify({ type: "ping" }));
            }
        }, 20000);
    }

    transferResult(taskid, response, status) {
        const result = { type: "response", taskid, response, status };
        this.sendMessage(JSON.stringify(result));
    }

    transferError(taskid, error, code) {
        const errorResponse = { type: "error", taskid, error, code };
        this.sendMessage(JSON.stringify(errorResponse));
    }
}

export { Gateway, Task };
