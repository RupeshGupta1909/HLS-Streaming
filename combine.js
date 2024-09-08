const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

/**
 * Combine images from multiple cameras into a grid and return the combined images.
 * @param {string} inputFolder - The folder containing the input images.
 * @param {number} numCameras - The number of cameras (i.e., number of columns in the grid).
 * @param {number} numImagesPerCamera - The number of images per camera (i.e., number of rows in the grid).
 * @param {number} imageWidth - The width of each image.
 * @param {number} imageHeight - The height of each image.
 * @returns {Promise<Buffer[]>} - A promise that resolves to an array of combined image buffers.
 */
async function createCombinedImages(inputFolder, numCameras, numImagesPerCamera, imageWidth, imageHeight) {
    if (numCameras <= 0 || numImagesPerCamera <= 0 || imageWidth <= 0 || imageHeight <= 0) {
        throw new Error('Invalid input parameters.');
    }

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
     * @param {number} rows 
     * @param {number} cols 
     * @returns {Promise<Buffer>}
     */
    async function combineImages(imagePaths, rows, cols) {
        // Read and buffer all images
        const images = await Promise.all(imagePaths.map(imagePath => sharp(imagePath).toBuffer()));
        console.log("--------------rows--", rows);
        // Create a blank image with the size of the final combined image
        const compositeImage = sharp({
            create: {
                width: cols * imageWidth,
                height: rows * imageHeight,
                channels: 3,
                background: 'black',
            },
        });

        // Composite images onto the blank image
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const index = row * cols + col;
                if (index < images.length) {
                    compositeImage.composite([{
                        input: images[index],
                        top: row * imageHeight,
                        left: col * imageWidth,
                    }]);
                }
            }
        }

        return compositeImage.toBuffer();
    }

    // Create and collect combined images
    const combinedImages = [];
    for (let i = 1; i <= numImagesPerCamera; i++) {
        const images = imagesByIndex[i];
        const numRows = Math.ceil(numCameras / 2);
        const numCols = Math.floor((numCameras + 1) / 2);
        const combinedImageBuffer = await combineImages(images, numRows, numCols);
        combinedImages.push(combinedImageBuffer);
    }

    return combinedImages;
}

(async () => {
    try {
        const inputFolder = 'D:\\HLS-test';
        const numCameras = 6;
        const numImagesPerCamera = 30;
        const imageWidth = 640;
        const imageHeight = 480;

        const combinedImages = await createCombinedImages(inputFolder, numCameras, numImagesPerCamera, imageWidth, imageHeight);

        // Save the combined images to disk
        combinedImages.forEach((buffer, index) => {
            fs.writeFileSync(`combined_image_${index + 1}.jpg`, buffer);
        });

        console.log('Combined images created successfully.');
    } catch (error) {
        console.error('Error creating combined images:', error);
    }
})();

