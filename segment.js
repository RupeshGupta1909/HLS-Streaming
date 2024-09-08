const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

async function createBlackImage(width, height, outputPath) {
    const blackImage = new Jimp(width, height, 'black');
    await blackImage.writeAsync(outputPath);
}

async function createCombinedImages(inputFolder, numCameras, numImagesPerCamera, finalWidth, finalHeight) {
    if (numCameras <= 0 || numImagesPerCamera <= 0 || finalWidth <= 0 || finalHeight <= 0) {
        throw new Error('Invalid input parameters.');
    }

    const imageWidth = Math.floor(finalWidth / 3);
    const imageHeight = Math.floor(finalHeight / 2);

    const imagesByIndex = [];
    for (let i = 1; i <= numImagesPerCamera; i++) {
        imagesByIndex[i] = [];
        for (let j = 1; j <= numCameras; j++) {
            const filePath = path.join(inputFolder, `cam${j}-img${i}.jpg`);
            if (fs.existsSync(filePath)) {
                imagesByIndex[i].push(filePath);
            } else {
                console.error(`File not found: ${filePath}`);
                throw new Error(`File not found: ${filePath}`);
            }
        }
    }

    async function combineImages(imagePaths) {
        const compositeImage = new Jimp(finalWidth, finalHeight, 'black');
        for (let row = 0; row < 2; row++) {
            for (let col = 0; col < 3; col++) {
                const index = row * 3 + col;
                if (index < imagePaths.length) {
                    const img = await Jimp.read(imagePaths[index]);
                    img.resize(imageWidth, imageHeight);
                    compositeImage.composite(img, col * imageWidth, row * imageHeight);
                }
            }
        }
        return compositeImage.getBufferAsync(Jimp.MIME_JPEG);
    }

    const combinedImages = [];
    for (let i = 1; i <= numImagesPerCamera; i++) {
        const images = imagesByIndex[i];
        const combinedImageBuffer = await combineImages(images);
        combinedImages.push(combinedImageBuffer);
    }
    return combinedImages;
}
async function createSegment(inputFolder, numCameras, numImagesPerCamera, imageWidth, imageHeight) {
    const audioFiles = fs.readdirSync(inputFolder).filter(file => file.endsWith('.mp3')).map(file => path.join(inputFolder, file));
    if (audioFiles.length === 0) {
        throw new Error('No audio files found.');
    }

    const combinedImages = await createCombinedImages(inputFolder, numCameras, numImagesPerCamera, imageWidth, imageHeight);

    const segmentFolder = path.join(inputFolder, 'segments');
    if (!fs.existsSync(segmentFolder)) {
        fs.mkdirSync(segmentFolder);
    }

    const blackImagePath = path.join(segmentFolder, 'black.png');
    await createBlackImage(imageWidth, imageHeight, blackImagePath);

    const batches = Math.ceil(combinedImages.length / 10);
    for (let batch = 0; batch < batches; batch++) {
        const batchFolder = path.join(segmentFolder, `batch_${batch + 1}`);
        if (!fs.existsSync(batchFolder)) {
            fs.mkdirSync(batchFolder);
        }

        const start = batch * 10;
        const end = start + 10;
        const segmentImagePaths = combinedImages.slice(start, end).map((buffer, index) => {
            const imagePath = path.join(batchFolder, `image_${index + 1}.png`);
            fs.writeFileSync(imagePath, buffer);
            return imagePath;
        });

        console.log('segmentImagePaths============', segmentImagePaths);

        const audioFile = audioFiles[batch];
        if (!audioFile) {
            throw new Error(`Audio file not found for batch ${batch + 1}`);
        }

        const videoFile = path.join(batchFolder, 'segment.mp4');
        const tempVideoFile = path.join(batchFolder, 'temp_segment.mp4');
        console.log('videoFile============', videoFile);

        // Create individual image video clips
        const imageClips = [];
        for (let i = 0; i < segmentImagePaths.length; i++) {
            const imageClipPath = path.join(batchFolder, `clip_${i}.mp4`);
            imageClips.push(imageClipPath);

            await new Promise((resolve, reject) => {
                ffmpeg()
                    .input(segmentImagePaths[i])
                    .loop(1)
                    .inputOptions('-t 1') // 1 second per image
                    .videoCodec('libx264')
                    .outputOptions('-pix_fmt yuv420p')
                    .output(imageClipPath)
                    .on('start', (cmd) => console.log(`Started ffmpeg with command: ${cmd}`))
                    .on('end', resolve)
                    .on('error', (err) => {
                        console.error('Error during image clip creation:', err);
                        reject(err);
                    })
                    .run();
            });
        }

        // Concatenate image video clips
        await new Promise((resolve, reject) => {
            const concatFilePath = path.join(batchFolder, 'concat_list.txt');
            fs.writeFileSync(concatFilePath, imageClips.map(clip => `file '${clip}'`).join('\n'));

            ffmpeg()
                .input(concatFilePath)
                .inputOptions('-f concat')
                .inputOptions('-safe 0')
                .outputOptions('-c copy')
                .output(tempVideoFile)
                .on('start', (cmd) => console.log(`Started ffmpeg with command: ${cmd}`))
                .on('end', resolve)
                .on('error', (err) => {
                    console.error('Error during concatenation:', err);
                    reject(err);
                })
                .run();
        });

        // Add audio to video
        await new Promise((resolve, reject) => {
            ffmpeg(tempVideoFile)
                .input(audioFile)
                .audioCodec('aac')
                .videoCodec('copy')
                .outputOptions('-pix_fmt yuv420p')
                .output(videoFile)
                .on('start', (cmd) => console.log(`Started ffmpeg with command: ${cmd}`))
                .on('end', () => {
                    fs.unlinkSync(tempVideoFile); // Remove temporary file
                    resolve();
                })
                .on('error', (err) => {
                    console.error('Error during adding audio to video:', err);
                    reject(err);
                })
                .run();
        });

        // Create HLS segments directly
        const hlsFolder = path.join(batchFolder, 'hls');
        if (!fs.existsSync(hlsFolder)) {
            fs.mkdirSync(hlsFolder);
        }

        await new Promise((resolve, reject) => {
            ffmpeg(videoFile)
                .outputOptions('-codec:v libx264')
                .outputOptions('-codec:a aac')
                .outputOptions('-hls_time 10')
                .outputOptions('-hls_list_size 0')
                .outputOptions('-f hls')
                .output(path.join(hlsFolder, 'playlist.m3u8'))
                .on('start', (cmd) => console.log(`Started ffmpeg with command: ${cmd}`))
                .on('end', resolve)
                .on('error', (err) => {
                    console.error('Error during HLS segment creation:', err);
                    reject(err);
                })
                .run();
        });

        // Move .ts files to the batch folder
        const tsFiles = fs.readdirSync(hlsFolder).filter(file => file.endsWith('.ts'));
        for (const file of tsFiles) {
            const oldPath = path.join(hlsFolder, file);
            const newPath = path.join(batchFolder, file);
            fs.renameSync(oldPath, newPath);
        }

        // Clean up
        fs.rmdirSync(hlsFolder, { recursive: true });
        fs.unlinkSync(videoFile);

        console.log('TS segments created and saved in:', batchFolder);
    }
}


const inputFolder = 'D:\\HLS-test'; // Adjust this path as needed
const numCameras = 6; // Number of cameras (columns)
const numImagesPerCamera = 30; // Number of images per camera (rows)
const finalWidth = 640; // Final combined image width
const finalHeight = 480; // Final combined image height

createSegment(inputFolder, numCameras, numImagesPerCamera, finalWidth, finalHeight)
    .then(() => console.log('All segments created successfully'))
    .catch(err => console.error('Error creating segments:', err));
