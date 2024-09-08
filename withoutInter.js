const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

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
        return compositeImage;
    }

    const combinedImages = [];
    for (let i = 1; i <= numImagesPerCamera; i++) {
        const images = imagesByIndex[i];
        const combinedImage = await combineImages(images);
        combinedImages.push(combinedImage);
    }
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
    for (let batch = 0; batch < batches; batch++) {
        const start = batch * 10;
        const end = start + 10;
        const segmentImages = combinedImages.slice(start, end);

        const tempImagePaths = [];
        for (let i = 0; i < segmentImages.length; i++) {
            const imagePath = path.join(segmentFolder, `temp_image_${batch}_${i + 1}.png`);
            await segmentImages[i].writeAsync(imagePath);
            tempImagePaths.push(imagePath);
        }

        const audioFile = audioFiles[batch];
        if (!audioFile) {
            throw new Error(`Audio file not found for batch ${batch + 1}`);
        }

        const tempVideoFile = path.join(segmentFolder, `temp_segment_${batch}.mp4`);

        // Create video directly from images
        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(path.join(segmentFolder, `temp_image_${batch}_%d.png`))
                .inputOptions('-framerate 1') // Frame rate: 1 image per second
                .outputOptions('-pix_fmt yuv420p')
                .output(tempVideoFile)
                .on('start', (cmd) => console.log(`Started ffmpeg with command: ${cmd}`))
                .on('end', resolve)
                .on('error', (err) => {
                    console.error('Error during video creation from images:', err);
                    reject(err);
                })
                .run();
        });

        // Add audio to video
        const videoFile = path.join(segmentFolder, `segment_${batch}.mp4`);
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
        const hlsFolder = path.join(segmentFolder, `hls_${batch}`);
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
                .output(path.join(hlsFolder, `playlist_${batch}.m3u8`))
                .on('start', (cmd) => console.log(`Started ffmpeg with command: ${cmd}`))
                .on('end', resolve)
                .on('error', (err) => {
                    console.error('Error during HLS segment creation:', err);
                    reject(err);
                })
                .run();
        });

        // Move .ts files to the segment folder
        const tsFiles = fs.readdirSync(hlsFolder).filter(file => file.endsWith('.ts'));
        for (const file of tsFiles) {
            const oldPath = path.join(hlsFolder, file);
            const newPath = path.join(segmentFolder, `segment_${batch}_${file}`);
            fs.renameSync(oldPath, newPath);
        }

        // Clean up
        fs.rmdirSync(hlsFolder, { recursive: true });
        fs.unlinkSync(videoFile);

        // Remove temporary images
        for (const tempImagePath of tempImagePaths) {
            fs.unlinkSync(tempImagePath);
        }

        console.log('TS segments created and saved in:', segmentFolder);
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
