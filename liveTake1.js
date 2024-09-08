const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { exec } = require('child_process');

const app = express();
const port = 3000;

const inputFolder = 'D:\\liveTest';
const segmentFolder = path.join(inputFolder, 'segments');
const numCameras = 6;
const numImagesPerSegment = 10;
const finalWidth = 640;
const finalHeight = 480;
const segmentDuration = 10;

if (!fs.existsSync(segmentFolder)) {
    fs.mkdirSync(segmentFolder);
}

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

let currentSegmentIndex=0;
function generateLiveData() {
    currentSegmentIndex++;
    
    // Generate images
    for (let i = 1; i <= numImagesPerSegment; i++) {
        for (let j = 1; j <= numCameras; j++) {
            const imgIndex = currentSegmentIndex * numImagesPerSegment + i;
            const filePath = path.join(inputFolder, `cam${j}-img${imgIndex}.jpg`);
            
            // Create a simple colored image with text
            const image = new Jimp(320, 240, `hsl(${Math.random() * 360}, 100%, 50%)`);
            Jimp.loadFont(Jimp.FONT_SANS_16_WHITE).then(font => {
                image.print(font, 10, 10, `Cam ${j} - Frame ${imgIndex}`);
                image.write(filePath);
            });
        }
    }
    
    // Generate audio (dummy file)
    const audioFile = path.join(inputFolder, `audio${currentSegmentIndex}.mp3`);
    exec(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t ${segmentDuration} -q:a 9 -acodec libmp3lame ${audioFile}`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error generating audio: ${error}`);
            return;
        }
        console.log(`Generated audio file: ${audioFile}`);
    });    
    console.log(`Generated live data for segment ${currentSegmentIndex}`);
}

// Generate live data every 10 seconds
setInterval(generateLiveData, segmentDuration * 1000);

// Function to create combined images from multiple cameras
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

// Create a segment on demand
async function createSegment(segmentIndex) {
    const audioFile = path.join(inputFolder, `audio${segmentIndex}.mp3`);
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

// Endpoint to serve manifest dynamically
app.get('/manifest', (req, res) => {
    console.log('Live manifest requested');

    // Get list of audio files (e.g., audio1.mp3, audio50.mp3)
    const audioFiles = fs.readdirSync(inputFolder)
        .filter(file => file.startsWith('audio') && file.endsWith('.mp3'))
        .sort((a, b) => {
            const numA = parseInt(a.match(/\d+/), 10);
            const numB = parseInt(b.match(/\d+/), 10);
            return numA - numB;
        });

    if (audioFiles.length === 0) {
        return res.status(404).send('No audio files found');
    }

    // Get the latest audio file (e.g., audio50.mp3)
    const latestAudioFile = audioFiles[audioFiles.length - 1];
    const latestSegmentIndex = parseInt(latestAudioFile.match(/\d+/), 10);  // Extract the segment number

    // Manifest starts from the latest segment index
    const manifestContent = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        `#EXT-X-TARGETDURATION:${segmentDuration}`,  // Duration of each segment (e.g., 10 seconds)
        '#EXT-X-PLAYLIST-TYPE:LIVE',  // Indicate live streaming
        `#EXT-X-MEDIA-SEQUENCE:${latestSegmentIndex}`,  // Start the sequence from the latest segment number
    ];

    // For live streaming, show the last 5 segments
    const numSegmentsToShow = 2;  // Number of recent segments to show in the manifest
    const startSegmentIndex = Math.max(latestSegmentIndex - numSegmentsToShow + 1, 0);

    for (let i = startSegmentIndex; i <= latestSegmentIndex; i++) {
        manifestContent.push(`#EXTINF:${segmentDuration.toFixed(1)},`);
        manifestContent.push(`/segment_${i}.ts`);
    }

    console.log('Manifest content:', manifestContent.join('\n'));
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(manifestContent.join('\n'));
});

// Serve the requested segment or generate it on demand
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
