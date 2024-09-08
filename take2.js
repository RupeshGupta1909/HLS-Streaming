const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

const app = express();
const port = 3000;

async function createCombinedImages(inputFolder, numCameras, numImagesPerCamera, finalWidth, finalHeight) {
    const imageWidth = Math.floor(finalWidth / 3);
    const imageHeight = Math.floor(finalHeight / 2);

    const imagesByIndex = [];
    for (let i = 1; i <= numImagesPerCamera; i++) {
        imagesByIndex[i] = [];
        for (let j = 1; j <= numCameras; j++) {
            const filePath = path.join(inputFolder, `cam${j}-img${i}.jpg`);
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
        Array.from({ length: numImagesPerCamera }, (_, i) => combineImages(imagesByIndex[i + 1]))
    );

    return combinedImages;
}

async function createSegment(inputFolder, numCameras, numImagesPerCamera, finalWidth, finalHeight) {
    const audioFiles = fs.readdirSync(inputFolder).filter(file => file.endsWith('.mp3')).map(file => path.join(inputFolder, file));
    if (audioFiles.length === 0) {
        throw new Error('No audio files found.');
    }

    const combinedImages = await createCombinedImages(inputFolder, numCameras, numImagesPerCamera, finalWidth, finalHeight);

    const segmentFolder = path.join(inputFolder, 'segments');
    if (!fs.existsSync(segmentFolder)) {
        fs.mkdirSync(segmentFolder);
    }

    const batches = Math.ceil(combinedImages.length / 10);
    await Promise.all(Array.from({ length: batches }, async (_, batch) => {
        const start = batch * 10;
        const end = Math.min(start + 10, combinedImages.length);

        // Create a list of temporary image file paths
        const tempImagePaths = await Promise.all(combinedImages.slice(start, end).map((img, i) => {
            const imagePath = path.join(segmentFolder, `temp_image_${batch}_${i + 1}.png`);
            return img.writeAsync(imagePath).then(() => imagePath);
        }));

        const audioFile = audioFiles[batch];
        if (!audioFile) {
            throw new Error(`Audio file not found for batch ${batch + 1}`);
        }

        // Use ffmpeg to generate .ts segments directly from images and audio
        await new Promise((resolve, reject) => {
            const ffmpegCommand = ffmpeg()
                .input(`concat:${tempImagePaths.join('|')}`)
                .inputOptions(['-framerate 1'])
                .input(audioFile)
                .audioCodec('aac')
                .videoCodec('libx264')
                .outputOptions([
                    '-pix_fmt yuv420p',
                    '-hls_time 10',
                    '-hls_list_size 0',
                    '-start_number 0',
                    '-hls_segment_filename', path.join(segmentFolder, `segment_${batch}.ts`)
                ])
                .output(path.join(segmentFolder, `segment_${batch}.ts`)) // Required for HLS
                .on('start', cmd => console.log(`Started ffmpeg with command: ${cmd}`))
                .on('end', () => {
                    // Clean up temporary image files
                    tempImagePaths.forEach(fs.unlinkSync);
                    resolve();
                })
                .on('error', reject)
                .run();
        });

        console.log(`TS segments created and saved in: ${segmentFolder}`);
    }));
}

async function createManifest(inputFolder) {
    const segmentFolder = path.join(inputFolder, 'segments');
    
    // Create the 'segments' folder if it doesn't exist
    if (!fs.existsSync(segmentFolder)) {
        fs.mkdirSync(segmentFolder);
    }

    const audioFiles = fs.readdirSync(inputFolder).filter(file => file.endsWith('.mp3'));

    if (audioFiles.length === 0) {
        throw new Error('No audio files found.');
    }

    const manifestPath = path.join(segmentFolder, 'manifest.m3u8');
    // const manifestContent = [
    //     '#EXTM3U',
    //     '#EXT-X-VERSION:3',
    //     '#EXT-X-TARGETDURATION:10',
    //     '#EXT-X-MEDIA-SEQUENCE:0',
    // ];

    // for (let i = 0; i < audioFiles.length; i++) {
    //     manifestContent.push(`#EXTINF:10.0`);
    //     manifestContent.push(`segment_${i}.ts`);
    // }
   const manifestContent =[];
     manifestContent.push('#EXTM3U');
     manifestContent.push(`#EXT-X-VERSION:3`);
     manifestContent.push(`#EXT-X-TARGETDURATION:10`);
    const segmentDuration = 10;
    // Add segments to the playlist
    for (let i = 0; i < audioFiles.length; i++) {
         manifestContent.push(`#EXTINF:${segmentDuration.toFixed(1)},`);
         manifestContent.push(`segment_${i}.ts`); // Example segment URL
    }

    // End of the playlist
    manifestContent.push(`#EXT-X-ENDLIST`);

    // manifestContent.push('#EXT-X-ENDLIST');

    fs.writeFileSync(manifestPath, manifestContent.join('\n'));

    console.log(`Manifest file created at: ${manifestPath}`);
}

// API endpoint to create segments and manifest
app.post('/create-segments', async (req, res) => {
    const inputFolder = 'D:\\HLS-test';
    const numCameras = 6;
    const numImagesPerCamera = 30;
    const finalWidth = 640;
    const finalHeight = 480;

    try {
        await createSegment(inputFolder, numCameras, numImagesPerCamera, finalWidth, finalHeight);
        await createManifest(inputFolder);
        res.status(200).send('Segments and manifest created successfully');
    } catch (err) {
        console.error('Error creating segments or manifest:', err);
        res.status(500).send('Error creating segments or manifest');
    }
});

app.get('/manifest', async (req, res) => {
    const inputFolder = 'D:\\HLS-test';
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


app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
