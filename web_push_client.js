/**
 * Copyright 2019 Bart Butenaers
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
    var settings = RED.settings;
    const fs = require('fs');
    const path = require('path');

    function HTML(config) {
        // Retrieve the config node, where the VAPID keys are configured
        var webPushConfig = RED.nodes.getNode(config.webPushConfig);
        
        // Pass the VAPID public key to the client side widget
        config.publicVapidKey = webPushConfig.publicKey;
        
        // The configuration is a Javascript object, which needs to be converted to a JSON string
        var configAsJson = JSON.stringify(config);
        
        var tooltipHtml = "";
        
        // Only show a tooltip when requested
        if (config.showTooltip) {
            tooltipHtml = String.raw`
                <md-tooltip
                    class="custom-tooltip"
                    md-delay="700" 
                    md-direction="bottom"
                    ng-bind-html="buttonTooltip">
                </md-tooltip>`;
        }
        
        var html = String.raw`  
            <style>
            .custom-tooltip {
                font-size: 14px;
            }
            </style>
            <md-button 
                id="button_subscribe_` + config.id + `"
                ng-class="{'nr-dashboard-disabled': !buttonEnabled}"
                ng-init='init(` + configAsJson + `)'
                ng-click="buttonClick()"
                ng-disabled={{buttonDisabled}}
                aria-label="{{buttonLabel}}"
                ng-style="{'z-index':1, 'padding':'0px'}">
                <ui-icon
                    ng-style="{'padding-left':'10px'}"
                    icon="{{buttonIcon}}">
                </ui-icon>
                <span
                    ng-style="{'padding-left':'10px', 'padding-right':'10px'}"
                    ng-bind-html="buttonLabel">
                </span>`
                + tooltipHtml + `
            </md-button>`;
            //<md-progress-circular ng-show="showProgressBar" md-mode="indeterminate"></md-progress-circular>   

        return html;
    };

    var ui = undefined;
    
    function WebPushClientNode(config) {
        var node = this;
        
        if(ui === undefined) {
            ui = RED.require("node-red-dashboard")(RED);
        }
        
        RED.nodes.createNode(this, config);
        
        var html = HTML(config);
        
        var done = ui.addWidget({
            node: node,
            group: config.group,
            order: config.order,
            width: config.width,
            height: config.height,
            format: html,
            templateScope: "local",
            emitOnlyNewValues: false,
            forwardInputMessages: false,
            storeFrontEndInputAsState: false,
            // Avoid (un)subscription confirmation popup dialog to appear automatically after deploy.
            // (see https://github.com/node-red/node-red-dashboard/pull/558)
            persistantFrontEndValue: false,
            convertBack: function (value) {
                return value;
            },
            beforeEmit: function(msg, value) {   
                return { msg: msg };
            },
            beforeSend: function (msg, orig) {
                if (orig) {
                    return orig.msg;
                }
            },
            initController: function($scope, events) {                       
                $scope.flag = true;
                $scope.buttonDisabled = false;
                $scope.showProgressBar = false;

                $scope.init = function (config) {
                    $scope.config = config;
                         
                    if (!('serviceWorker' in navigator)) {
                        $scope.buttonAction  = "NONE";
                        $scope.buttonEnabled = false;
                        $scope.buttonIcon    = "fa-thumbs-o-up";
                        $scope.buttonLabel   = "<span>" + $scope.config.subscribeLabel + "</span>";
                        $scope.buttonTooltip = "<span>No service worker support!</span>";
                        
                        if ($scope.config.disableButton) {
                            $scope.buttonDisabled = true;
                        }
                        
                        // Update the new text on the button
                        $scope.$digest();
                        
                        return;
                    }
                    
                    // This feature is available only in secure contexts (HTTPS) !!!!!!!!!!!!!!!!
                    // This feature is not available with self signed certificates !!!!!!!!!!!!!!!!
                    if (!('PushManager' in window)) {
                        $scope.buttonAction  = "NONE";
                        $scope.buttonEnabled = false;
                        $scope.buttonIcon    = "fa-thumbs-o-up";
                        $scope.buttonLabel   = "<span>" + $scope.config.subscribeLabel + "</span>";
                        $scope.buttonTooltip = "<span>No push notification support!</span>";
                        
                        if ($scope.config.disableButton) {
                            $scope.buttonDisabled = true;
                        }
                        
                        // Update the new text on the button
                        $scope.$digest();
                        
                        return;
                    }                    
         
                    // Compose the url where the browser can fetch our service worker Javascript file.
                    // The node.id contains a '.' which is not allowed in urls, so let's replace it by a '_'
                    var serviceUrl = 'ui_web_push/' + $scope.config.id.replace(/\./g,'_') + '/nodered_push_service.js';

                    // ALWAYS register a service worker, even when the user doesn't subscribe for push notifications.
                    // It will run in background (as a separate thread) and won't do anything until the browser calls it.
                    // The service.js file will contain all our service worker code. 
                    // One of the advantages of registering it in advance: it will have very shortly status 'installed' and then
                    // get status 'active'.  If we would register immediately before we request a subscription from the push 
                    // manager, then it will have the incorrect status (i.e. 'installed' instead of 'active') which will cause a failure.
                    // When a service worker (with the same url) is already active, then nothing will happen here.
                    // But when there is no active service worker, then one will be registered here ...
                    navigator.serviceWorker.register(serviceUrl).then(function(serviceWorkerRegistration) {
                        $scope.serviceWorkerRegistration = serviceWorkerRegistration;
                        
                        // Check whether currently a push subscription is already available for the service worker
                        $scope.serviceWorkerRegistration.pushManager.getSubscription().then(function(pushSubscription) {
                            // TODO deze nog gebruiken
                            $scope.hasPushSubscription = !(pushSubscription === null);
                            
                            if (pushSubscription && $scope.config.sendSubscription) {
                                // Send the push subscription to the subscription manager inside the Node-RED flow, to make sure the 
                                // subscription manager is up-to-date anyway.  We only send it when requested on the config screen.
                                // But this means that the subscription manager in Node-RED should remove duplicate subscriptions!
                                $scope.send({
                                    // TODO moeten we JSON.stringify van de subscription doen ???
                                    payload: pushSubscription,
                                    topic: "subscription_existing"
                                });
                            }

                            // Set the UI button status initially correct, to reflect the current subscription
                            updateUI(pushSubscription);
                        }).catch(function(error) {
                            logError('Cannot get subscription from service worker:\n' + error);
                            return;
                        });
                    }).catch(function(error) {
                        logError('Cannot register service worker:\n' + error);
                        return;
                    });
                }
                
                // urlB64ToUint8Array is a magic function that will encode the base64 public key
                // to Array buffer which is needed by the subscription option
                const urlB64ToUint8Array = base64String => {
                    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
                    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
                    const rawData = atob(base64);
                    const outputArray = new Uint8Array(rawData.length);
                    for (var i = 0; i < rawData.length; ++i) {
                        outputArray[i] = rawData.charCodeAt(i);
                    }
                    return outputArray;
                }
                
                function logError(error) {
                    // Log the error on the client-side in the browser console log
                    console.log(error);
                    
                    // Send the error to the server-side to handle there
                    $scope.send({
                        payload: error,
                        topic: "error"
                    });
                }
                
                function updateUI(pushSubscription) {
                    if (pushSubscription) {
                        $scope.buttonAction  = "UNSUBSCRIBE";
                        $scope.buttonEnabled = true;
                        $scope.buttonIcon    = "fa-ban";
                        $scope.buttonLabel   = "<span>" + $scope.config.unsubscribeLabel + "</span>";
                        $scope.buttonTooltip = "<span>Stop receiving notifications</span>";
                    }
                    else {
                        $scope.buttonAction  = "SUBSCRIBE";
                        $scope.buttonEnabled = true;
                        $scope.buttonIcon    = "fa-play-circle-o";
                        $scope.buttonLabel   = "<span>" + $scope.config.subscribeLabel + "</span>";
                        $scope.buttonTooltip = "<span>Start receiving notifications</span>";
                    }
                    
                    // Force an update of the view (i.e. digestion) to make sure the update of the model is visualized.
                    // Otherwise the updated wasn't executed for me on Windows 10 (Edge and Firefox) and Android (Chrome)...
                    $scope.$digest();
                }

                function subscribe(permission) {
                    $scope.showProgressBar = true;
                    
                    switch (permission) {
                        case "granted": 
                            // The user has explicitly granted permission for the current origin to display system notifications.
                            // So let's continue ...
                            break;
                        case "denied": 
                            // TODO is this the correct way of working ??
                            logError("This domain is denied to send notifications!\nIt can be allowed again via the browser settings.");
                            return;
                        case "default":
                            // The user decision is unknown, since the user has closed the permission popup via the 'X' button.
                            // In this case the application will act as if permission was denied.
                            logError("This domain is not explicit granted to send notifications!\nIt can be allowed again via the browser settings.");
                            return;
                    }

                    // The public VAPID key needs to be included in the request
                    const applicationServerKey = urlB64ToUint8Array($scope.config.publicVapidKey);
                    const options = { applicationServerKey, userVisibleOnly: true };
                                
                    // Subscribe to the push manager (from Google, Mozilla, Apple, ...), if not done yet
                    $scope.serviceWorkerRegistration.pushManager.subscribe(options).then(function(pushSubscription) {
                        console.log('The subsubscription in the browser push manager is completed');

                        // Send the new push subscription to the subscription manager inside the Node-RED flow
                        $scope.send({
                            payload: pushSubscription,
                            topic: "subscription_new"
                        });

                        console.log("Message has been send to subscribe in the Node-RED subscription manager");

                        // Set the UI button status initially correct, to reflect the new subscription
                        updateUI(pushSubscription);
                    }).catch(function(error) {
                        logError("Cannot subscribe to the browser's push manager:\n" + error);
                    }).finally(function() {
                        $scope.showProgressBar = false;
                    });
                }
                    
                function unsubscribe() {
                    $scope.showProgressBar = true;
                    
                    // Check whether currently a push subscription is already available for the service worker
                    $scope.serviceWorkerRegistration.pushManager.getSubscription().then(function(pushSubscription) {
                        pushSubscription.unsubscribe().then(function(successful) {
                            if (successful) {
                                console.log("Succesfully unsubscribed from the browser's push manager");
                                
                                // Remove the subscription from the subscription manager inside the Node-RED flow
                                $scope.send({
                                    payload: pushSubscription,
                                    topic: "unsubscription"
                                });
                                
                                console.log("Removed the subscription from the subscription manager in Node-RED");
                        
                                // Set the UI button status initially correct, to reflect the removed subscription
                                updateUI(null);
                            }
                            else {
                                logError("Cannot unsubscribe from the browser's push manager");
                            }
                        }).catch(function(error) {
                            logError('Cannot unsubscribe from the push manager:\n' + error);
                        })
                    }).catch(function(error) {
                        logError('Cannot get a subscription from the service worker:\n' + error);
                    }).finally(function() {
                        $scope.showProgressBar = false;
                    });
                }
                
                $scope.buttonClick = function() {
                    switch ($scope.buttonAction) {
                        case "SUBSCRIBE":
                            // Push notification can only be send to the browser, when the user has granted his permission for this domain.
                            // The requestPermission will show a popup to the user, only when this domain hasn't been granted or denied yet.
                            // If this domain is already denied in the past, the user will have to remove this domain manually from the 
                            // blocked domain list (in his browser settings).  And afterwards try this again ...
                            // Recently the Notification.requestPermission uses a promise, but Safari still uses a callback function!
                            try {
                                // Promise-based approach
                                Notification.requestPermission().then(function(permission) {
                                    subscribe(permission);
                                });
                            }
                            catch(error) {
                                // Callback-based approach for Safari
                                Notification.requestPermission(function(permission) {
                                    subscribe(permission);
                                });
                            }
                            break;
                        case "UNSUBSCRIBE":
                            unsubscribe();
                            break;
                        default: // "NONE"
                            // We should never arrive here, because the button should be disabled ...
                            logError("No action is currently possible");
                    }
                    
                }

                $scope.$watch('msg', function(msg) {
                    // Ignore undefined messages.
                    if (!msg) {
                        return;
                    }
                    
                    // As soon as we have a new version of the nodered_push_service.js on the server, that should be loaded by the browser. 
                    // However that isn't the case, since navigator.serviceWorker.register doesn't load the file again when loaded previously already...
                    // There are some workarounds (See more details on https://developers.google.com/web/updates/2019/09/fresher-sw) :
                    // - We could set updateViaCache to 'none' (in navigator.serviceWorker.register), to avoid that the nodered_push_service.js is 
                    //   being stored in the http cache.  
                    // - Or we could (in the http endpoint) do "res.set('Cache-Control', 'max-age=0');" to make sure the browser will not store 
                    //   the nodered_push_service.js in the http cache.  Same as previous point, but now for older browsers.
                    // But in both solutions we would fetch it every time from the server to get the latest version, which would result in more traffic ...  
                    // Therefore we will update it manually ...
                    // Remark: within 24 hours your service worker will update (they will check every 24 hours to see if there is a newer version available).
                    if (msg.payload && msg.payload === "reload_service_worker") {
                        if (!('serviceWorker' in navigator)) {
                            console.log('Cannot reload service worker, because service workers are NOT supported by this browser!');
                            return;
                        }
                        
                        if ($scope.serviceWorkerRegistration) {
                            // Fetch the worker's script URL.  If the new worker is not byte-by-byte identical to the current worker, it installs the new worker.
                            // The fetch of the worker bypasses any browser caches if the previous fetch occurred over 24 hours ago.
                            $scope.serviceWorkerRegistration.update();
                            
                            console.log("The registration has been updated");
                        }
                        
                        // TODO resultaat terugsturen ...
                    }
                });                        
            }
        });

        node.on("close", function() {
            if (done) {
                done();
            }
        });
    }

    RED.nodes.registerType("ui_web_push_client", WebPushClientNode);
    
    // By default the UI path in the settings.js file will be in comment:
    //     //ui: { path: "ui" },
    // But as soon as the user has specified a custom UI path there, we will need to use that path:
    //     ui: { path: "mypath" },
    var uiPath = ((RED.settings.ui || {}).path) || 'ui';
	
    // Create the complete server-side path.
    // Normally the node id is not required in the endpoint, however we want to register the (same) service worker script
    // for every ui-web-push node.  Reason is that each service worker registration can have its own push subscription.
    // Indeed each ui-web-push node can have its own vapid configuration, so it needs its own service worker.  That 
    // way multiple vapid configurations can be used on a single dashboard, although I don't see any use cases at the moment.
    uiPath = '/' + uiPath + '/ui_web_push/:node_id/nodered_push_service.js';
    
    // Replace a sequence of multiple slashes (e.g. // or ///) by a single one
    uiPath = uiPath.replace(/\/+/g, '/');
	
    // Make all the static resources from this node public available (i.e. Service worker javascript file).
    RED.httpNode.get(uiPath, function(req, res){
        var nodeId = req.params.node_id;
        
        // In the client we had to replace the '.' by a '_', so lets restore it ...
        nodeId = nodeId.replace('_','.');
        
        var webPushClientNode = RED.nodes.getNode(nodeId);
        
        if (!webPushClientNode) {
            node.error("Cannot return service worker file for unexisting web-push-client node id = " + nodeId);
            res.status(404).json({error: 'No service worker file for unknown node id'});
            return;
        }
        
        var options = {
            root: __dirname /*+ '/lib/'*/,
            dotfiles: 'deny'
        };
        
        const filePath = path.join(__dirname, '/service_worker.js')

        var fileContent = fs.readFileSync(filePath).toString();
        if(!fileContent) {
            node.error("Cannot read service worker file from filesystem");
            res.status(404).json({error: 'Cannot read service worker file'});
            return;
        }
            
        var nodeRedUrl = req.protocol + '://' + req.get('host'); // E.g. https://somehostname:1880/webpush
        
        // Determine the path to the dashboard, which will be used when the notification is being clicked
        var dashboardPath = "";
        if (RED.settings.httpRoot && RED.settings.httpRoot !== "" && RED.settings.httpRoot !== "/") {
            // The httpRoot value overrides the httpNodeRoot value
            dashboardPath += RED.settings.httpRoot;
        }
        else {
            // Only use the httpNodeRoot value when it is not false
            if (RED.settings.httpNodeRoot !== false && RED.settings.httpRoot !== "" && RED.settings.httpRoot !== "/") {
                dashboardPath += RED.settings.httpNodeRoot;
            }
        }
        dashboardPath += ((RED.settings.ui || {}).path) || 'ui';
        
        // At the start of the service.js file, 2 placeholders need to be replaced by their real value.
        // This is required because the service worker will run in the browser background, so it needs to be able to communicate with the Node-RED server ...
        fileContent = fileContent.replace("#node-red-url#"    , nodeRedUrl);
        fileContent = fileContent.replace("#dashboard-path#"  , dashboardPath);
        // TODO we could define the '/webpush' path inside the config screen, and inject it as a 4th parameter into the file ...
        
        // Send the requested file to the client
        res.type("js").send(fileContent);
    });
}
