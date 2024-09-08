const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

/**
 * Combine images from multiple cameras into a grid and return the combined images.
 * @param {string} inputFolder - The folder containing the input images.
 * @param {number} numCameras - The number of cameras (i.e., number of columns in the grid).
 * @param {number} numImagesPerCamera - The number of images per camera (i.e., number of rows in the grid).
 * @param {number} finalWidth - The width of the final combined image.
 * @param {number} finalHeight - The height of the final combined image.
 * @returns {Promise<Buffer[]>} - A promise that resolves to an array of combined image buffers.
 */
async function createCombinedImages(inputFolder, numCameras, numImagesPerCamera, finalWidth, finalHeight) {
    if (numCameras <= 0 || numImagesPerCamera <= 0 || finalWidth <= 0 || finalHeight <= 0) {
        throw new Error('Invalid input parameters.');
    }

    const imageWidth = Math.floor(finalWidth / 3);
    const imageHeight = Math.floor(finalHeight / 2);

    // Gather all images
    const imagesByIndex = [];
    for (let i = 1; i <= numImagesPerCamera; i++) {
        imagesByIndex[i] = [];
        for (let j = 1; j <= numCameras; j++) {
            const filePath = path.join(inputFolder, `cam${j}-img${i}.jpg`);
            if (fs.existsSync(filePath)) {
                imagesByIndex[i].push(filePath);
            } else {
                throw new Error(`File not found: ${filePath}`);
            }
        }
    }

    /**
     * Combine images into a single large image.
     * @param {string[]} imagePaths
     * @returns {Promise<Buffer>}
     */
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

    // Create and collect combined images
    const combinedImages = [];
    for (let i = 1; i <= numImagesPerCamera; i++) {
        const images = imagesByIndex[i];
        const combinedImageBuffer = await combineImages(images);
        combinedImages.push(combinedImageBuffer);
    }

    return combinedImages;
}

(async () => {
    try {
        const inputFolder = 'D:\\HLS-test';
        const numCameras = 6;
        const numImagesPerCamera = 30;
        const finalWidth = 640;
        const finalHeight = 480;

        const combinedImages = await createCombinedImages(inputFolder, numCameras, numImagesPerCamera, finalWidth, finalHeight);

        // Save the combined images to disk
        combinedImages.forEach((buffer, index) => {
            fs.writeFileSync(`combined_image_${index + 1}.jpg`, buffer);
        });

        console.log('Combined images created successfully.');
    } catch (error) {
        console.error('Error creating combined images:', error);
    }
})();
