const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

const app = express();
const port = 3000;

const inputFolder = 'D:\\HLS-test1';
const segmentFolder = path.join(inputFolder, 'segments');
const numCameras = 6;
const numImagesPerSegment = 10;
const finalWidth = 640;
const finalHeight = 480;
const preGenerateSegments = 5;

if (!fs.existsSync(segmentFolder)) {
    fs.mkdirSync(segmentFolder);
}
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

async function createCombinedImages(segmentIndex, numImagesPerSegment) {
    const imageWidth = Math.floor(finalWidth / 3);
    const imageHeight = Math.floor(finalHeight / 2);
    const imagesByIndex = [];

    for (let i = 1; i <= numImagesPerSegment; i++) {
        const imgIndex = segmentIndex * numImagesPerSegment + i;
        imagesByIndex[i] = [];
        for (let j = 1; j <= numCameras; j++) {
            const filePath = path.join(inputFolder, `cam${j}-img${imgIndex}.jpg`);
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
async function createSegment(segmentIndex) {
    const audioFile = path.join(inputFolder, `audio${segmentIndex + 1}.mp3`);
    if (!fs.existsSync(audioFile)) {
        throw new Error(`Audio file not found for segment ${segmentIndex}`);
    }

    const combinedImages = await createCombinedImages(segmentIndex, numImagesPerSegment);

    const tempImagePaths = await Promise.all(combinedImages.map((img, i) => {
        const imagePath = path.join(segmentFolder, `temp_image_${segmentIndex}_${i + 1}.png`);
        return img.writeAsync(imagePath).then(() => imagePath);
    }));

    const outputPath = path.join(segmentFolder, `segment_${segmentIndex}.ts`);

    await new Promise((resolve, reject) => {
                const ffmpegCommand = ffmpeg()
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
            ]).output(outputPath)
            .on('start', cmd => console.log(`Started ffmpeg with command: ${cmd}`))
            .on('end', () => {
                tempImagePaths.forEach(fs.unlinkSync);
                resolve();
            })
            .on('error', reject)
            .run();
    });

    console.log(`TS segment ${segmentIndex} created and saved as: ${outputPath}`);
}

async function preGenerateInitialSegments() {
    for (let i = 0; i < preGenerateSegments; i++) {
        await createSegment(i);
    }
    console.log(`Pre-generated ${preGenerateSegments} segments`);
}

app.get('/manifest', (req, res) => {
    console.log('Manifest requested');
    const audioFiles = fs.readdirSync(inputFolder).filter(file => file.endsWith('.mp3'));
    const manifestContent = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:10',
        '#EXT-X-MEDIA-SEQUENCE:0',
    ];

    const segmentDuration = 10;
    for (let i = 0; i < audioFiles.length; i++) {
        manifestContent.push(`#EXTINF:${segmentDuration.toFixed(1)},`);
        manifestContent.push(`/segment_${i}.ts`);
    }
    manifestContent.push('#EXT-X-ENDLIST');
    console.log('Manifest content:', manifestContent.join('\n'));
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(manifestContent.join('\n'));

    // Start pre-generating initial segments after sending the manifest
    // preGenerateInitialSegments();
});

app.get('/segment_:index.ts', async (req, res) => {
    console.log(`Segment requested: ${req.params.index}`);
    const segmentIndex = parseInt(req.params.index, 10);
    const segmentPath = path.join(segmentFolder, `segment_${segmentIndex}.ts`);

    if (fs.existsSync(segmentPath)) {
        res.setHeader('Content-Type', 'video/mp2t');
        res.sendFile(segmentPath);
    } else {
        try {
            await createSegment(segmentIndex);
            res.setHeader('Content-Type', 'video/mp2t');
            res.sendFile(segmentPath);
        } catch (err) {
            console.error(`Error creating segment ${segmentIndex}:`, err);
            res.status(500).send(`Error creating segment ${segmentIndex}`);
        }
    }
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});