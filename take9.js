const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

const app = express();
const port = 3000;

const baseFolder = 'D:\\HLS-withProperFolder';
const numCameras = 6;
const numImagesPerSegment = 10;
const finalWidth = 640;
const finalHeight = 480;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

function getDeviceFolders() {
    return fs.readdirSync(baseFolder).filter(folder => folder.startsWith('Device_Id'));
}

function getDateFolders(deviceId) {
    const devicePath = path.join(baseFolder, deviceId);
    return fs.readdirSync(devicePath);
}

function getSegmentFolders(deviceId, date) {
    const datePath = path.join(baseFolder, deviceId, date);
    return fs.readdirSync(datePath).filter(folder => folder.startsWith('segment_'));
}

async function createCombinedImages(deviceId, date, segmentFolder) {
    const imageWidth = Math.floor(finalWidth / 3);
    const imageHeight = Math.floor(finalHeight / 2);
    const segmentPath = path.join(baseFolder, deviceId, date, segmentFolder);
    const segmentIndex = segmentFolder.split('_')[1];
    const imagesByIndex = [];

    for (let i = 1; i <= numImagesPerSegment; i++) {
        imagesByIndex[i] = [];
        const imgIndex = segmentIndex * numImagesPerSegment + i;
        for (let j = 1; j <= numCameras; j++) {
            const filePath = path.join(segmentPath, `cam${j}-img${imgIndex-10}.jpg`);
            if (!fs.existsSync(filePath)) {
                throw new Error(`File not found: ${filePath}`);
            }
            imagesByIndex[i].push(filePath);
        }
    }

    async function combineImages(imagePaths) {
        const compositeImage = new Jimp(finalWidth, finalHeight, 'black');
        await Promise.all(imagePaths.map(async (imagePath, index) => {
            const row = Math.floor(index / 3);
            const col = index % 3;
            const img = await Jimp.read(imagePath);
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
    const segmentPath = path.join(baseFolder, deviceId, date, segmentFolder);
    const audioFile = path.join(segmentPath, 'audio.mp3');
    if (!fs.existsSync(audioFile)) {
        throw new Error(`Audio file not found for segment ${segmentFolder}`);
    }

    const combinedImages = await createCombinedImages(deviceId, date, segmentFolder);

    const tempImagePaths = await Promise.all(combinedImages.map((img, i) => {
        const imagePath = path.join(segmentPath, `temp_image_${i + 1}.png`);
        return img.writeAsync(imagePath).then(() => imagePath);
    }));

    const outputPath = path.join(segmentPath, 'segment.ts');

    await new Promise((resolve, reject) => {
        ffmpeg()
            .input(`concat:${tempImagePaths.join('|')}`)
            .inputOptions(['-framerate 1'])
            .input(audioFile)
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
                resolve();
            })
            .on('error', reject)
            .run();
    });

    console.log(`TS segment created and saved as: ${outputPath}`);
    return outputPath;
}

app.get('/manifest/:deviceId/:date', (req, res) => {
    const { deviceId, date } = req.params;
    console.log(`Manifest requested for ${deviceId} on ${date}`);

    const segmentFolders = getSegmentFolders(deviceId, date);
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

    const segmentPath = path.join(baseFolder, deviceId, date, segmentFolder, 'segment.ts');

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