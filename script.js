// Global State
const { PDFDocument } = window.PDFLib;
let pdfDoc = null;
let pageNum = 1;
let pageRendering = false;
let pageNumPending = null;
let scale = 1.0;
let rotation = 0;
let fabricCanvas = null;
let isRestoringHistory = false;

// Annotation State
let annotations = {}; // { pageNum: { data: null, undoStack: [], redoStack: [] } }
let currentTool = 'select';
let toolColor = '#ffffff';
let toolThickness = 2;

// Drawing Shape State
let isDrawingShape = false;
let startX, startY;
let activeShape = null;

// DOM Elements
const elements = {
    uploadInput: document.getElementById('pdf-upload'),
    uploadInputCenter: document.getElementById('pdf-upload-center'),
    loader: document.getElementById('loader'),
    initialState: document.getElementById('initial-state'),
    pdfContainer: document.getElementById('pdf-container'),
    pdfCanvas: document.getElementById('pdf-render'),
    annotationCanvas: document.getElementById('annotation-layer'),
    sidebar: document.getElementById('sidebar'),
    propertiesPanel: document.getElementById('properties-panel'),
    paginationControls: document.getElementById('pagination-controls'),
    pageNumDisplay: document.getElementById('page-num'),
    pageCountDisplay: document.getElementById('page-count'),
    prevPageBtn: document.getElementById('prev-page'),
    nextPageBtn: document.getElementById('next-page'),
    zoomInBtn: document.getElementById('zoom-in'),
    zoomOutBtn: document.getElementById('zoom-out'),
    zoomValDisplay: document.getElementById('zoom-val'),
    rotateBtn: document.getElementById('rotate-page'),
    fullscreenBtn: document.getElementById('fullscreen-mode'),
    thumbnailsContainer: document.getElementById('thumbnails'),
    
    // Tools
    toolBtns: document.querySelectorAll('.tool-btn[data-tool]'),
    colorPicker: document.getElementById('tool-color'),
    thicknessPicker: document.getElementById('tool-thickness'),
    thicknessValDisplay: document.getElementById('thickness-val'),
    undoBtn: document.getElementById('undo-btn'),
    redoBtn: document.getElementById('redo-btn')
};

// Initialize PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Setup Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    elements.uploadInput.addEventListener('change', handlePdfUpload);
    elements.uploadInputCenter.addEventListener('change', handlePdfUpload);
    
    // Pagination
    elements.prevPageBtn.addEventListener('click', onPrevPage);
    elements.nextPageBtn.addEventListener('click', onNextPage);
    
    // Zoom
    elements.zoomInBtn.addEventListener('click', () => { scale += 0.25; queueRenderPage(pageNum); });
    elements.zoomOutBtn.addEventListener('click', () => { if(scale <= 0.25) return; scale -= 0.25; queueRenderPage(pageNum); });
    
    // Rotate and Fullscreen
    elements.rotateBtn.addEventListener('click', () => { rotation = (rotation + 90) % 360; queueRenderPage(pageNum); });
    elements.fullscreenBtn.addEventListener('click', toggleFullscreen);

    // Tools Setup
    setupTools();
    
    // Export
    document.getElementById('export-pdf').addEventListener('click', exportEditedPDF);
});

/**
 * Handle initial upload of PDF file
 */
function handlePdfUpload(e) {
    const file = e.target.files[0];
    if (file.type !== 'application/pdf') {
        alert('Please select a valid PDF file.');
        return;
    }

    const fileReader = new FileReader();
    elements.loader.classList.remove('hidden');

    fileReader.onload = function() {
        const typedarray = new Uint8Array(this.result);
        loadPDF(typedarray);
    };

    fileReader.readAsArrayBuffer(file);
}

/**
 * Load PDF Document via PDF.js API
 */
async function loadPDF(data) {
    try {
        const loadingTask = pdfjsLib.getDocument({data: data});
        pdfDoc = await loadingTask.promise;
        
        // Hide initial state, show workspace
        elements.initialState.classList.add('hidden');
        elements.pdfContainer.classList.remove('hidden');
        elements.sidebar.classList.remove('hidden');
        elements.propertiesPanel.classList.remove('hidden');
        elements.paginationControls.classList.remove('hidden');
        document.getElementById('export-pdf').classList.remove('hidden');

        // Update pagination
        elements.pageCountDisplay.textContent = pdfDoc.numPages;
        pageNum = 1;

        // Generate thumbnails
        generateThumbnails();

        // Render first page
        renderPage(pageNum);

        elements.loader.classList.add('hidden');
    } catch (error) {
        console.error('Error loading PDF:', error);
        alert('Error loading PDF.');
        elements.loader.classList.add('hidden');
    }
}

/**
 * Get page info from document, resize canvas accordingly, and render page
 */
async function renderPage(num) {
    pageRendering = true;
    
    try {
        const page = await pdfDoc.getPage(num);
        const viewport = page.getViewport({ scale: scale, rotation: rotation });
        
        // Prepare PDF canvas
        const canvas = elements.pdfCanvas;
        const ctx = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        // Adjust container size
        elements.pdfContainer.style.width = `${viewport.width}px`;
        elements.pdfContainer.style.height = `${viewport.height}px`;

        // Update Zoom Text
        elements.zoomValDisplay.textContent = `${Math.round(scale * 100)}%`;

        // Render PDF page into canvas context
        const renderContext = {
            canvasContext: ctx,
            viewport: viewport
        };
        const renderTask = page.render(renderContext);

        await renderTask.promise;
        
        // Setup/Resize Fabric.js Canvas
        setupFabricCanvas(viewport.width, viewport.height);

        // Update active thumbnail
        updateActiveThumbnail(num);

        pageRendering = false;
        
        // Update page counters
        elements.pageNumDisplay.textContent = num;

        if (pageNumPending !== null) {
            renderPage(pageNumPending);
            pageNumPending = null;
        }

    } catch (error) {
        console.error('Error rendering page:', error);
    }
}

/**
 * Initialize or resize Fabric canvas
 */
function setupFabricCanvas(width, height) {
    if (!fabricCanvas) {
        fabricCanvas = new fabric.Canvas('annotation-layer', {
            isDrawingMode: false,
            selection: true
        });

        // Event Bindings for Undo/Redo
        fabricCanvas.on('path:created', () => saveState());
        fabricCanvas.on('object:modified', () => saveState());
        fabricCanvas.on('object:added', (e) => {
            if (e.target && !e.target.isRestoring) saveState();
        });
        
        // Custom Drawing logic
        fabricCanvas.on('mouse:down', onCanvasMouseDown);
        fabricCanvas.on('mouse:move', onCanvasMouseMove);
        fabricCanvas.on('mouse:up', onCanvasMouseUp);
    }

    fabricCanvas.setWidth(width);
    fabricCanvas.setHeight(height);
    
    // Initialize page state if empty
    if (!annotations[pageNum]) {
        annotations[pageNum] = { data: null, undoStack: [], redoStack: [] };
    }

    // Restore state for current page
    fabricCanvas.clear();
    if (annotations[pageNum].data) {
        isRestoringHistory = true;
        fabricCanvas.loadFromJSON(annotations[pageNum].data, () => {
            fabricCanvas.renderAll();
            applyToolBehavior(); // Re-apply current tool
            isRestoringHistory = false;
        });
    } else {
        applyToolBehavior();
    }
}

/**
 * Pagination Controls handlers
 */
function queueRenderPage(num) {
    if (pageRendering) {
        pageNumPending = num;
    } else {
        renderPage(num);
    }
}

function onPrevPage() {
    if (pageNum <= 1) return;
    saveCurrentPageAnnotations();
    pageNum--;
    queueRenderPage(pageNum);
}

function onNextPage() {
    if (pageNum >= pdfDoc.numPages) return;
    saveCurrentPageAnnotations();
    pageNum++;
    queueRenderPage(pageNum);
}

/**
 * Thumbnail Generation
 */
async function generateThumbnails() {
    elements.thumbnailsContainer.innerHTML = ''; // Clear existing
    
    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale: 0.2 }); // Small scale for thumbnail
        
        const wrapper = document.createElement('div');
        wrapper.className = 'thumbnail-wrapper';
        wrapper.id = `thumbnail-wrapper-${i}`;
        wrapper.onclick = () => { pageNum = i; queueRenderPage(pageNum); };
        
        const canvasContainer = document.createElement('div');
        canvasContainer.className = 'thumbnail-canvas-container';
        
        const canvas = document.createElement('canvas');
        canvas.id = `thumbnail-page-${i}`;
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        
        const ctx = canvas.getContext('2d');
        const renderContext = { canvasContext: ctx, viewport: viewport };
        page.render(renderContext); // Non-blocking render
        
        const pageNumLabel = document.createElement('span');
        pageNumLabel.className = 'thumbnail-page-num';
        pageNumLabel.textContent = `Page ${i}`;
        
        canvasContainer.appendChild(canvas);
        wrapper.appendChild(canvasContainer);
        wrapper.appendChild(pageNumLabel);
        
        elements.thumbnailsContainer.appendChild(wrapper);
    }
}

function updateActiveThumbnail(num) {
    document.querySelectorAll('.thumbnail-wrapper').forEach(el => el.classList.remove('active'));
    const activeThumb = document.getElementById(`thumbnail-wrapper-${num}`);
    if (activeThumb) {
        activeThumb.classList.add('active');
        activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

/**
 * Fullscreen toggle
 */
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
            console.error(`Error attempting to enable fullscreen: ${err.message}`);
        });
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }
}

/**
 * Annotation Tools & Logic
 */
function setupTools() {
    elements.toolBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            elements.toolBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTool = btn.dataset.tool;
            applyToolBehavior();
        });
    });

    elements.colorPicker.addEventListener('input', (e) => {
        toolColor = e.target.value;
        applyToolBehavior();
        updateSelectedObjectsColor();
    });

    elements.thicknessPicker.addEventListener('input', (e) => {
        toolThickness = parseInt(e.target.value);
        elements.thicknessValDisplay.textContent = `${toolThickness}px`;
        applyToolBehavior();
        updateSelectedObjectsThickness();
    });

    elements.undoBtn.addEventListener('click', undo);
    elements.redoBtn.addEventListener('click', redo);
    
    // Set default active tool
    document.querySelector('.tool-btn[data-tool="select"]').classList.add('active');
}

function applyToolBehavior() {
    if (!fabricCanvas) return;
    
    // Reset defaults
    fabricCanvas.isDrawingMode = false;
    fabricCanvas.selection = true;
    fabricCanvas.defaultCursor = 'default';
    fabricCanvas.getObjects().forEach(obj => obj.set('selectable', true));

    if (currentTool === 'select') {
        // Defaults apply
    } 
    else if (currentTool === 'draw') {
        fabricCanvas.isDrawingMode = true;
        fabricCanvas.freeDrawingBrush = new fabric.PencilBrush(fabricCanvas);
        fabricCanvas.freeDrawingBrush.color = toolColor;
        fabricCanvas.freeDrawingBrush.width = toolThickness;
    }
    else if (currentTool === 'highlight') {
        fabricCanvas.isDrawingMode = true;
        fabricCanvas.freeDrawingBrush = new fabric.PencilBrush(fabricCanvas);
        // Hex to RGBA with opacity
        let r = parseInt(toolColor.slice(1, 3), 16),
            g = parseInt(toolColor.slice(3, 5), 16),
            b = parseInt(toolColor.slice(5, 7), 16);
        fabricCanvas.freeDrawingBrush.color = `rgba(${r},${g},${b},0.4)`;
        fabricCanvas.freeDrawingBrush.width = toolThickness * 4; // Thicker for highlight
    }
    else if (currentTool === 'erase') {
        fabricCanvas.defaultCursor = 'crosshair';
        fabricCanvas.selection = false;
        fabricCanvas.getObjects().forEach(obj => obj.set('selectable', false));
    }
    else if (['rect', 'circle', 'text'].includes(currentTool)) {
        fabricCanvas.defaultCursor = 'crosshair';
        fabricCanvas.selection = false;
    }
}

// Shape Drawing logic
function onCanvasMouseDown(o) {
    if (currentTool === 'erase') {
        if (o.target) {
            fabricCanvas.remove(o.target);
            saveState();
        }
        return;
    }

    if (!['rect', 'circle', 'text'].includes(currentTool)) return;
    
    isDrawingShape = true;
    let pointer = fabricCanvas.getPointer(o.e);
    startX = pointer.x;
    startY = pointer.y;

    if (currentTool === 'rect') {
        activeShape = new fabric.Rect({
            left: startX, top: startY, width: 0, height: 0,
            fill: 'transparent',
            stroke: toolColor,
            strokeWidth: toolThickness,
            selectable: false
        });
        activeShape.isRestoring = true; // Prevent object:added from firing saveState yet
        fabricCanvas.add(activeShape);
    } else if (currentTool === 'circle') {
        activeShape = new fabric.Circle({
            left: startX, top: startY, radius: 0,
            fill: 'transparent',
            stroke: toolColor,
            strokeWidth: toolThickness,
            selectable: false
        });
        activeShape.isRestoring = true;
        fabricCanvas.add(activeShape);
    } else if (currentTool === 'text') {
        const text = new fabric.IText('Text', {
            left: startX,
            top: startY,
            fill: toolColor,
            fontSize: 20 + toolThickness * 2,
            fontFamily: 'Inter'
        });
        fabricCanvas.add(text);
        fabricCanvas.setActiveObject(text);
        text.enterEditing();
        text.selectAll();
        isDrawingShape = false; // text is instantly inserted
        saveState();
        
        // Reset tool to select after text insertion
        currentTool = 'select';
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.tool-btn[data-tool="select"]').classList.add('active');
        applyToolBehavior();
    }
}

function onCanvasMouseMove(o) {
    if (!isDrawingShape || !activeShape) return;
    let pointer = fabricCanvas.getPointer(o.e);
    
    if (currentTool === 'rect') {
        if(startX > pointer.x) { activeShape.set({ left: Math.abs(pointer.x) }); }
        if(startY > pointer.y) { activeShape.set({ top: Math.abs(pointer.y) }); }
        activeShape.set({ width: Math.abs(startX - pointer.x) });
        activeShape.set({ height: Math.abs(startY - pointer.y) });
    } else if (currentTool === 'circle') {
        let radius = Math.abs(startX - pointer.x) / 2;
        if(startX > pointer.x) { activeShape.set({ left: Math.abs(pointer.x) }); }
        if(startY > pointer.y) { activeShape.set({ top: Math.abs(pointer.y) }); }
        activeShape.set({ radius: radius });
    }
    fabricCanvas.renderAll();
}

function onCanvasMouseUp(o) {
    if (!isDrawingShape) return;
    isDrawingShape = false;
    if (activeShape) {
        activeShape.setCoords();
        activeShape.isRestoring = false;
        saveState();
        activeShape = null;
    }
}

// Modify existing objects
function updateSelectedObjectsColor() {
    if(!fabricCanvas) return;
    const active = fabricCanvas.getActiveObjects();
    if(active.length) {
        active.forEach(obj => {
            if (obj.type === 'i-text') obj.set('fill', toolColor);
            else obj.set('stroke', toolColor);
        });
        fabricCanvas.renderAll();
        saveState();
    }
}

function updateSelectedObjectsThickness() {
    if(!fabricCanvas) return;
    const active = fabricCanvas.getActiveObjects();
    if(active.length) {
        active.forEach(obj => {
            if (obj.type !== 'i-text') obj.set('strokeWidth', toolThickness);
        });
        fabricCanvas.renderAll();
        saveState();
    }
}

/**
 * State Management
 */
function saveCurrentPageAnnotations() {
    if (fabricCanvas && annotations[pageNum]) {
        annotations[pageNum].data = fabricCanvas.toJSON();
    }
}

function saveState() {
    if(isRestoringHistory || !fabricCanvas || !annotations[pageNum]) return;
    const json = fabricCanvas.toJSON();
    annotations[pageNum].data = json;
    annotations[pageNum].undoStack.push(json);
    annotations[pageNum].redoStack = []; // clear redo on new action
}

function undo() {
    if (!annotations[pageNum] || annotations[pageNum].undoStack.length === 0) return;
    
    const current = annotations[pageNum].undoStack.pop();
    annotations[pageNum].redoStack.push(current);
    
    if (annotations[pageNum].undoStack.length === 0) {
        isRestoringHistory = true;
        fabricCanvas.clear();
        annotations[pageNum].data = null;
        isRestoringHistory = false;
        return;
    }
    
    const previous = annotations[pageNum].undoStack[annotations[pageNum].undoStack.length - 1];
    isRestoringHistory = true;
    fabricCanvas.loadFromJSON(previous, () => {
        fabricCanvas.renderAll();
        annotations[pageNum].data = previous;
        isRestoringHistory = false;
    });
}

function redo() {
    if (!annotations[pageNum] || annotations[pageNum].redoStack.length === 0) return;
    const next = annotations[pageNum].redoStack.pop();
    annotations[pageNum].undoStack.push(next);
    
    isRestoringHistory = true;
    fabricCanvas.loadFromJSON(next, () => {
        fabricCanvas.renderAll();
        annotations[pageNum].data = next;
        isRestoringHistory = false;
    });
}

/**
 * Export Logic (Phase 4)
 */
async function exportEditedPDF() {
    const isConfirmed = confirm("Are you sure you want to export the edited PDF?");
    if (!isConfirmed) return;

    const exportPdfBtn = document.getElementById('export-pdf');
    exportPdfBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Exporting...';
    exportPdfBtn.classList.add('disabled');
    
    try {
        saveCurrentPageAnnotations();
        const pdfBytes = await pdfDoc.getData();
        const pdfDocLib = await PDFDocument.load(pdfBytes);
        
        for (let i = 1; i <= pdfDoc.numPages; i++) {
            if (annotations[i] && annotations[i].data) {
                const parsedData = typeof annotations[i].data === 'string' ? JSON.parse(annotations[i].data) : annotations[i].data;
                if (parsedData.objects && parsedData.objects.length > 0) {
                    const page = pdfDocLib.getPages()[i - 1];
                    const width = page.getWidth();
                    const height = page.getHeight();
                    
                    // Create offscreen canvas matched to PDF page dimensions
                    // Note: Since PDF page could be rotated or scaled, we render at 1x scale without rotation for overlay.
                    let tCanvas = new fabric.StaticCanvas(null, { width: width, height: height });
                    
                    await new Promise((resolve) => {
                        tCanvas.loadFromJSON(annotations[i].data, () => {
                            tCanvas.renderAll();
                            resolve();
                        });
                    });
                    
                    const imgDataUrl = tCanvas.toDataURL({ format: 'png' });
                    const pngImage = await pdfDocLib.embedPng(imgDataUrl);
                    page.drawImage(pngImage, {
                        x: 0,
                        y: 0,
                        width: width,
                        height: height,
                    });
                }
            }
        }
        
        const finalPdfBytes = await pdfDocLib.save();
        const blob = new Blob([finalPdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'DocCanvas_Edited.pdf';
        document.body.appendChild(a);
        a.click();
        URL.revokeObjectURL(url);
        a.remove();
        
    } catch (e) {
        console.error('Export Failed:', e);
        alert('An error occurred while exporting the PDF.');
    }
    
    exportPdfBtn.innerHTML = '<i class="fa-solid fa-download"></i> Export';
    exportPdfBtn.classList.remove('disabled');
}
