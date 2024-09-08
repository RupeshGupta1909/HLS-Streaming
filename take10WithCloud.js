const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { BlobServiceClient } = require("@azure/storage-blob");

const app = express();
const port = 3000;


const blobServiceClient = BlobServiceClient.fromConnectionString(_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient(containerName);

const tempFolder = 'D:\\HLS-segment';
const numCameras = 6;
const numImagesPerSegment = 10;
const finalWidth = 640;
const finalHeight = 480;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

async function getDeviceFolders() {
    const deviceFolders = [];-
    console.log("--------=======containerClinet", containerClient);
    for await (const item of containerClient.listBlobsByHierarchy('/')) {
        if (item.kind === "prefix" && item.name.startsWith('Device_Id')) {
            deviceFolders.push(item.name.slice(0, -1));
        }
    }
    return deviceFolders;
}

async function getDateFolders(deviceId) {
    const dateFolders = [];
    for await (const item of containerClient.listBlobsByHierarchy(`${deviceId}/`)) {
        if (item.kind === "prefix") {
            dateFolders.push(item.name.split('/')[1]);
        }
    }
    return dateFolders;
}

async function getSegmentFolders(deviceId, date) {
    const segmentFolders = new Set();
    const prefix = `${deviceId}/${date}/`;
    
    console.log(`Listing blobs with prefix: ========    ${prefix}`);
    
    for await (const blob of containerClient.listBlobsFlat({ prefix: prefix })) {
        // console.log(`Found blob: ${blob.name}`);
        const parts = blob.name.split('/');
        if (parts.length > 2 && parts[2].startsWith('segment_')) {
            segmentFolders.add(parts[2]);
        }
    }
    
    const sortedSegments = Array.from(segmentFolders).sort((a, b) => {
        const numA = parseInt(a.split('_')[1]);
        const numB = parseInt(b.split('_')[1]);
        return numA - numB;
    });
    
    console.log(`Found segment folders: ${JSON.stringify(sortedSegments)}`);
    return sortedSegments;
}

async function downloadBlob(blobName) {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const downloadResponse = await blockBlobClient.download();
    return await streamToBuffer(downloadResponse.readableStreamBody);
}

async function streamToBuffer(readableStream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on("data", (data) => {
            chunks.push(data instanceof Buffer ? data : Buffer.from(data));
        });
        readableStream.on("end", () => {
            resolve(Buffer.concat(chunks));
        });
        readableStream.on("error", reject);
    });
}

async function createCombinedImages(deviceId, date, segmentFolder) {
    const imageWidth = Math.floor(finalWidth / 3);
    const imageHeight = Math.floor(finalHeight / 2);
    const segmentIndex = segmentFolder.split('_')[1];
    const imagesByIndex = [];

    for (let i = 1; i <= numImagesPerSegment; i++) {
        imagesByIndex[i] = [];
        const imgIndex = segmentIndex * numImagesPerSegment + i;
        for (let j = 1; j <= numCameras; j++) {
            const blobName = `${deviceId}/${date}/${segmentFolder}/cam${j}-img${imgIndex-10}.jpg`;
            const imageBuffer = await downloadBlob(blobName);
            imagesByIndex[i].push(imageBuffer);
        }
    }

    async function combineImages(imageBuffers) {
        const compositeImage = new Jimp(finalWidth, finalHeight, 'black');
        await Promise.all(imageBuffers.map(async (imageBuffer, index) => {
            const row = Math.floor(index / 3);
            const col = index % 3;
            const img = await Jimp.read(imageBuffer);
            img.resize(imageWidth, imageHeight);
            compositeImage.composite(img, col * imageWidth, row * imageHeight);
        }));
        return compositeImage;
    }

    const combinedImages = await Promise.all(
        Array.from({ length: numImagesPerSegment }, (_, i) => combineImages(imagesByIndex[i + 1]))
    );

    return combinedImages;
}

async function createSegment(deviceId, date, segmentFolder) {
    const audioPath = path.join(tempFolder, 'temp_audio.mp3');

    if (!fs.existsSync(tempFolder)) {
        fs.mkdirSync(tempFolder, { recursive: true });
    }
    
    // Download and write the audio buffer to the temp audio file
    const audioBlob = `${deviceId}/${date}/${segmentFolder}/audio.mp3`;
    const audioBuffer = await downloadBlob(audioBlob);
    fs.writeFileSync(audioPath, audioBuffer);

    const combinedImages = await createCombinedImages(deviceId, date, segmentFolder);

    const tempImagePaths = await Promise.all(combinedImages.map((img, i) => {
        const imagePath = path.join(tempFolder, `temp_image_${i + 1}.png`);
        return img.writeAsync(imagePath).then(() => imagePath);
    }));

    const outputPath = path.join(tempFolder, `${deviceId}_${date}_${segmentFolder}.ts`);

    await new Promise((resolve, reject) => {
        ffmpeg()
            .input(`concat:${tempImagePaths.join('|')}`)
            .inputOptions(['-framerate 1'])
            .input(audioPath)
            .audioCodec('aac')
            .audioBitrate('128k')
            .videoCodec('libx264')
            .outputOptions([
                '-pix_fmt yuv420p',
                '-f mpegts',
                '-muxdelay 0',
                '-muxpreload 0.5',
                '-max_delay 0',
                '-shortest'
            ])
            .output(outputPath)
            .on('end', () => {
                tempImagePaths.forEach(fs.unlinkSync);
                fs.unlinkSync(audioPath);
                resolve();
            })
            .on('error', reject)
            .run();
    });

    console.log(`TS segment created and saved as: ${outputPath}`);
    return outputPath;
}

app.get('/manifest/:deviceId/:date', async (req, res) => {
    const { deviceId, date } = req.params;
    console.log(`Manifest requested for=========== ${deviceId} on ${date}`);

    const segmentFolders = await getSegmentFolders(deviceId, date);
    const manifestContent = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:10',
        '#EXT-X-MEDIA-SEQUENCE:0',
    ];

    const segmentDuration = 10;
    segmentFolders.forEach((folder, index) => {
        manifestContent.push(`#EXTINF:${segmentDuration.toFixed(1)},`);
        manifestContent.push(`/segment/${deviceId}/${date}/${folder}`);
    });
    manifestContent.push('#EXT-X-ENDLIST');

    console.log('Manifest content:', manifestContent.join('\n'));
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(manifestContent.join('\n'));
});

app.get('/segment/:deviceId/:date/:segmentFolder', async (req, res) => {
    const { deviceId, date, segmentFolder } = req.params;
    console.log(`Segment requested: ${deviceId}/${date}/${segmentFolder}`);

    const segmentPath = path.join(tempFolder, `${deviceId}_${date}_${segmentFolder}.ts`);

    if (fs.existsSync(segmentPath)) {
        res.setHeader('Content-Type', 'video/mp2t');
        res.sendFile(segmentPath);
    } else {
        try {
            const createdSegmentPath = await createSegment(deviceId, date, segmentFolder);
            res.setHeader('Content-Type', 'video/mp2t');
            res.sendFile(createdSegmentPath);
        } catch (err) {
            console.error(`Error creating segment ${segmentFolder}:`, err);
            res.status(500).send(`Error creating segment ${segmentFolder}`);
        }
    }
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});