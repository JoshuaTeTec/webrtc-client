/*
 *  Copyright (c) 2015 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */

'use strict';

const startButton = document.getElementById('startButton');
const callButton = document.getElementById('callButton');
const hangupButton = document.getElementById('hangupButton');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

callButton.disabled = true;
hangupButton.disabled = true;
startButton.addEventListener('click', start);
callButton.addEventListener('click', call);
hangupButton.addEventListener('click', hangup);

let localStream;
let peerConnection;
let ws; // Notre connexion au serveur de signalisation

// ---------------------------------------------------------
// 1. CONNEXION AU SERVEUR WEBSOCKET (SIGNALISATION)
// ---------------------------------------------------------
function connectWebSocket() {
    // Si vous testez avec votre téléphone sur le même réseau WiFi,
    // remplacez 'localhost' par l'adresse IP locale de votre PC (ex: 192.168.1.50)
    const userPassword = prompt("Veuillez entrer la clé de notre canal privé :");
    if (!userPassword) {
        alert("Mot de passe requis pour se connecter.");
        return;
    }
    const wsUrl = `wss://https://webrtc-serveur.onrender.com/?token=${userPassword}`;
    ws = new WebSocket(wsUrl);

    ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);

        // Si on reçoit une offre SDP de l'autre appareil
        if (message.type === 'offer') {
            console.log('Offre reçue, création de la réponse...');
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message));
            const answer = await peerConnection.createAnswer();
            answer.sdp = optimizeSDPForLowBandwidth(answer.sdp); // On force nos règles hardcore
            await peerConnection.setLocalDescription(answer);
            ws.send(JSON.stringify(peerConnection.localDescription));
        }
        // Si on reçoit une réponse SDP de l'autre appareil
        else if (message.type === 'answer') {
            console.log('Réponse reçue, établissement de la connexion...');
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message));
        }
        // Si on reçoit un candidat ICE (le chemin réseau trouvé par l'autre appareil)
        else if (message.type === 'candidate') {
            console.log('Candidat réseau (ICE) reçu');
            await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
        }
    };
}

// ---------------------------------------------------------
// 2. CAPTURE DE LA CAMÉRA (Règles Bas Débit)
// ---------------------------------------------------------
async function start() {
    startButton.disabled = true;
    try {
        const constraints = {
            audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
            video: {
                width: { ideal: 320, max: 480 },
                height: { ideal: 240, max: 360 },
                frameRate: { ideal: 10, max: 15 } // Bridage à 15 fps max
            }
        };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        localVideo.srcObject = localStream;
        callButton.disabled = false;
        
        // On initialise la connexion réseau et le WebSocket dès que la caméra est prête
        setupPeerConnection();
        connectWebSocket();
        
    } catch (e) {
        alert(`Erreur caméra: ${e.name}`);
    }
}

// ---------------------------------------------------------
// 3. PRÉPARATION DE LA CONNEXION WEBRTC
// ---------------------------------------------------------
function setupPeerConnection() {
    // Les serveurs STUN publics de Google pour découvrir nos adresses IP
    const configuration = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };
    
    peerConnection = new RTCPeerConnection(configuration);

    // Envoyer nos "candidats réseau" (nos IPs) au serveur dès qu'on les trouve
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({
                type: 'candidate',
                candidate: event.candidate
            }));
        }
    };

    // Afficher la vidéo de l'autre quand elle arrive
    peerConnection.ontrack = (event) => {
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        }
    };

    // Ajouter notre flux vidéo/audio à la connexion
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    // Verrouillage de la bande passante vidéo (100 kbps max)
    const senders = peerConnection.getSenders();
    const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
    if (videoSender) {
        const parameters = videoSender.getParameters();
        if (!parameters.encodings) parameters.encodings = [{}];
        parameters.encodings[0].maxBitrate = 100000;
        videoSender.setParameters(parameters).catch(e => console.error(e));
    }
}

// ---------------------------------------------------------
// 4. LANCER L'APPEL
// ---------------------------------------------------------
async function call() {
    callButton.disabled = true;
    hangupButton.disabled = false;
    console.log('Création de l\'offre...');

    try {
        const offer = await peerConnection.createOffer();
        offer.sdp = optimizeSDPForLowBandwidth(offer.sdp); // On force nos règles hardcore
        await peerConnection.setLocalDescription(offer);
        
        // On envoie l'offre au serveur pour qu'il la relaie à l'autre appareil
        ws.send(JSON.stringify(peerConnection.localDescription));
    } catch (e) {
        console.error("Erreur d'appel:", e);
    }
}

function hangup() {
    peerConnection.close();
    peerConnection = null;
    hangupButton.disabled = true;
    callButton.disabled = false;
}

// ---------------------------------------------------------
// 5. LA MAGIE TÉLÉCOM (Optimisation SDP)
// ---------------------------------------------------------
function optimizeSDPForLowBandwidth(sdp) {
    let modifiedSdp = sdp.replace(
        /(a=fmtp:\d+ .*)/g,
        '$1;useinbandfec=1;usedtx=1;maxaveragebitrate=48000'
    );
    modifiedSdp = modifiedSdp.replace(
        /c=IN (.*)\r\n/g,
        'c=IN $1\r\nb=AS:150\r\n'
    );
    return modifiedSdp;
}