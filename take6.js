const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

const app = express();
const port = 3000;

async function createCombinedImages(inputFolder, numCameras, segmentIndex, numImagesPerSegment, finalWidth, finalHeight) {
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

async function createSegment(inputFolder, numCameras, segmentIndex, numImagesPerSegment, finalWidth, finalHeight) {
    const audioFile = path.join(inputFolder, `audio${segmentIndex + 1}.mp3`);
    if (!fs.existsSync(audioFile)) {
        throw new Error(`Audio file not found for segment ${segmentIndex}`);
    }

    const combinedImages = await createCombinedImages(inputFolder, numCameras, segmentIndex, numImagesPerSegment, finalWidth, finalHeight);

    const segmentFolder = path.join(inputFolder, 'segments');
    if (!fs.existsSync(segmentFolder)) {
        fs.mkdirSync(segmentFolder);
    }

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
            .videoCodec('libx264')
            .outputOptions([
                '-pix_fmt yuv420p'
            ])
            .output(outputPath)
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

app.get('/manifest', async (req, res) => {
    const inputFolder = 'D:\\HLS-test1';
    const audioFiles = fs.readdirSync(inputFolder).filter(file => file.endsWith('.mp3'));
    if (audioFiles.length === 0) {
        return res.status(404).send('No audio files found');
    }
    const segmentFolder = path.join(inputFolder, 'segments');
    if (!fs.existsSync(segmentFolder)) {
        fs.mkdirSync(segmentFolder);
    }
    const manifestPath = path.join(segmentFolder, 'manifest.m3u8');
    const manifestContent = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:10',
        '#EXT-X-MEDIA-SEQUENCE:0',
    ];

    const segmentDuration = 10;
    for (let i = 0; i < audioFiles.length; i++) {
        manifestContent.push(`#EXTINF:${segmentDuration.toFixed(1)},`);
        manifestContent.push(`segment_${i}.ts`);
    }
    manifestContent.push('#EXT-X-ENDLIST');
    fs.writeFileSync(manifestPath, manifestContent.join('\n'));
    console.log(`Manifest file created at: ${manifestPath}`);
    if (fs.existsSync(manifestPath)) {
        res.sendFile(manifestPath);
    } else {
        res.status(404).send('Manifest not found');
    }
});

app.use((req, res, next) => {
    console.log(`Request URL: ${req.url}`);
    next();
});

app.get('/segment_:index.ts', async (req, res) => {
    const inputFolder = 'D:\\HLS-test1';
    const numCameras = 6;
    const numImagesPerSegment = 10;
    const finalWidth = 640;
    const finalHeight = 480;
    const segmentIndex = parseInt(req.params.index, 10);

    try {
        const segmentPath = path.join(inputFolder, 'segments', `segment_${segmentIndex}.ts`);
        if (!fs.existsSync(segmentPath)) {
            await createSegment(inputFolder, numCameras, segmentIndex, numImagesPerSegment, finalWidth, finalHeight);
        }
        res.sendFile(segmentPath);
    } catch (err) {
        console.error(`Error creating or serving segment ${segmentIndex}:`, err);
        res.status(500).send(`Error creating or serving segment ${segmentIndex}`);
    }
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});