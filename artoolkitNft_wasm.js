var Module = typeof Module !== "undefined" ? Module : {};
(function () {
  "use strict";
  if (window.artoolkit_wasm_url) {
    function downloadWasm(url) {
      return new Promise(function (resolve, reject) {
        var wasmXHR = new XMLHttpRequest;
        wasmXHR.open("GET", url, true);
        wasmXHR.responseType = "arraybuffer";
        wasmXHR.onload = function () {
          resolve(wasmXHR.response)
        };
        wasmXHR.onerror = function () {
          reject("error " + wasmXHR.status)
        };
        wasmXHR.send(null)
      })
    }
    var wasm = downloadWasm(window.artoolkit_wasm_url);
    Module.instantiateWasm = function (imports, successCallback) {
      console.log("instantiateWasm: instantiating synchronously");
      wasm.then(function (wasmBinary) {
        console.log("wasm download finished, begin instantiating");
        var wasmInstantiate = WebAssembly.instantiate(new Uint8Array(wasmBinary), imports).then(function (output) {
          console.log("wasm instantiation succeeded");
          successCallback(output.instance)
        }).catch(function (e) {
          console.log("wasm instantiation failed! " + e)
        })
      });
      return {}
    }
  }
  var ARController = function (width, height, cameraPara) {
    this.id = undefined;
    var w = width,
      h = height;
    this.orientation = "landscape";
    this.listeners = {};
    if (typeof width !== "number") {
      var image = width;
      cameraPara = height;
      w = image.videoWidth || image.width;
      h = image.videoHeight || image.height;
      this.image = image
    }
    this.nftMarkerCount = 0;
    this.defaultMarkerWidth = 1;
    this.patternMarkers = {};
    this.barcodeMarkers = {};
    this.nftMarkers = {};
    this.transform_mat = new Float32Array(16);
    this.transformGL_RH = new Float64Array(16);
    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext("2d");
    this.videoWidth = w;
    this.videoHeight = h;
    this.videoSize = this.videoWidth * this.videoHeight;
    this.framepointer = null;
    this.framesize = null;
    this.dataHeap = null;
    this.videoLuma = null;
    this.camera_mat = null;
    this.marker_transform_mat = null;
    this.videoLumaPointer = null;
    this._bwpointer = undefined;
    this._lumaCtx = undefined;
    if (typeof cameraPara === "string") {
      this.cameraParam = new ARCameraParam(cameraPara, function () {
        this._initialize()
      }.bind(this), function (err) {
        console.error("ARController: Failed to load ARCameraParam", err);
        this.onload(err)
      }.bind(this))
    } else {
      this.cameraParam = cameraPara;
      this._initialize()
    }
  };
  ARController.prototype.dispose = function () {
    if (this.id > -1) {
      artoolkit.teardown(this.id)
    }
    if (this.image && this.image.srcObject) {
      ARController._teardownVideo(this.image)
    }
    for (var t in this) {
      this[t] = null
    }
  };
  ARController.prototype.process = function (image) {
    var result = this.detectMarker(image);
    if (result != 0) {
      console.error("detectMarker error: " + result)
    }
    var markerNum = this.getMarkerNum();
    var k, o;
    for (k in this.patternMarkers) {
      o = this.patternMarkers[k];
      o.inPrevious = o.inCurrent;
      o.inCurrent = false
    }
    for (k in this.barcodeMarkers) {
      o = this.barcodeMarkers[k];
      o.inPrevious = o.inCurrent;
      o.inCurrent = false
    }
    for (k in this.nftMarkers) {
      o = this.nftMarkers[k];
      o.inPrevious = o.inCurrent;
      o.inCurrent = false
    }
    for (var i = 0; i < markerNum; i++) {
      var markerInfo = this.getMarker(i);
      var markerType = artoolkit.UNKNOWN_MARKER;
      var visible = this.trackPatternMarkerId(-1);
      if (markerInfo.idPatt > -1 && (markerInfo.id === markerInfo.idPatt || markerInfo.idMatrix === -1)) {
        visible = this.trackPatternMarkerId(markerInfo.idPatt);
        markerType = artoolkit.PATTERN_MARKER;
        if (markerInfo.dir !== markerInfo.dirPatt) {
          this.setMarkerInfoDir(i, markerInfo.dirPatt)
        }
      } else if (markerInfo.idMatrix > -1) {
        visible = this.trackBarcodeMarkerId(markerInfo.idMatrix);
        markerType = artoolkit.BARCODE_MARKER;
        if (markerInfo.dir !== markerInfo.dirMatrix) {
          this.setMarkerInfoDir(i, markerInfo.dirMatrix)
        }
      }
      if (markerType !== artoolkit.UNKNOWN_MARKER && visible.inPrevious) {
        this.getTransMatSquareCont(i, visible.markerWidth, visible.matrix, visible.matrix)
      } else {
        this.getTransMatSquare(i, visible.markerWidth, visible.matrix)
      }
      visible.inCurrent = true;
      this.transMatToGLMat(visible.matrix, this.transform_mat);
      this.transformGL_RH = this.arglCameraViewRHf(this.transform_mat);
      this.dispatchEvent({
        name: "getMarker",
        target: this,
        data: {
          index: i,
          type: markerType,
          marker: markerInfo,
          matrix: this.transform_mat,
          matrixGL_RH: this.transformGL_RH
        }
      })
    }
    var nftMarkerCount = this.nftMarkerCount;
    artoolkit.detectNFTMarker(this.id);
    for (var i = 0; i < nftMarkerCount; i++) {
      var markerInfo = this.getNFTMarker(i);
      if (markerInfo.found) {
        var visible = this.trackNFTMarkerId(i);
        visible.matrix.set(markerInfo.pose);
        visible.inCurrent = true;
        this.transMatToGLMat(visible.matrix, this.transform_mat);
        this.transformGL_RH = this.arglCameraViewRHf(this.transform_mat);
        this.dispatchEvent({
          name: "getNFTMarker",
          target: this,
          data: {
            index: i,
            marker: markerInfo,
            matrix: this.transform_mat,
            matrixGL_RH: this.transformGL_RH
          }
        })
      }
    }
    var multiMarkerCount = this.getMultiMarkerCount();
    for (var i = 0; i < multiMarkerCount; i++) {
      var subMarkerCount = this.getMultiMarkerPatternCount(i);
      var visible = false;
      artoolkit.getTransMatMultiSquareRobust(this.id, i);
      this.transMatToGLMat(this.marker_transform_mat, this.transform_mat);
      this.transformGL_RH = this.arglCameraViewRHf(this.transform_mat);
      for (var j = 0; j < subMarkerCount; j++) {
        var multiEachMarkerInfo = this.getMultiEachMarker(i, j);
        if (multiEachMarkerInfo.visible >= 0) {
          visible = true;
          this.dispatchEvent({
            name: "getMultiMarker",
            target: this,
            data: {
              multiMarkerId: i,
              matrix: this.transform_mat,
              matrixGL_RH: this.transformGL_RH
            }
          });
          break
        }
      }
      if (visible) {
        for (var j = 0; j < subMarkerCount; j++) {
          var multiEachMarkerInfo = this.getMultiEachMarker(i, j);
          this.transMatToGLMat(this.marker_transform_mat, this.transform_mat);
          this.transformGL_RH = this.arglCameraViewRHf(this.transform_mat);
          this.dispatchEvent({
            name: "getMultiMarkerSub",
            target: this,
            data: {
              multiMarkerId: i,
              markerIndex: j,
              marker: multiEachMarkerInfo,
              matrix: this.transform_mat,
              matrixGL_RH: this.transformGL_RH
            }
          })
        }
      }
    }
    if (this._bwpointer) {
      this.debugDraw()
    }
  };
  ARController.prototype.trackPatternMarkerId = function (id, markerWidth) {
    var obj = this.patternMarkers[id];
    if (!obj) {
      this.patternMarkers[id] = obj = {
        inPrevious: false,
        inCurrent: false,
        matrix: new Float64Array(12),
        matrixGL_RH: new Float64Array(12),
        markerWidth: markerWidth || this.defaultMarkerWidth
      }
    }
    if (markerWidth) {
      obj.markerWidth = markerWidth
    }
    return obj
  };
  ARController.prototype.trackBarcodeMarkerId = function (id, markerWidth) {
    var obj = this.barcodeMarkers[id];
    if (!obj) {
      this.barcodeMarkers[id] = obj = {
        inPrevious: false,
        inCurrent: false,
        matrix: new Float64Array(12),
        matrixGL_RH: new Float64Array(12),
        markerWidth: markerWidth || this.defaultMarkerWidth
      }
    }
    if (markerWidth) {
      obj.markerWidth = markerWidth
    }
    return obj
  };
  ARController.prototype.trackNFTMarkerId = function (id, markerWidth) {
    var obj = this.nftMarkers[id];
    if (!obj) {
      this.nftMarkers[id] = obj = {
        inPrevious: false,
        inCurrent: false,
        matrix: new Float64Array(12),
        matrixGL_RH: new Float64Array(12),
        markerWidth: markerWidth || this.defaultMarkerWidth
      }
    }
    if (markerWidth) {
      obj.markerWidth = markerWidth
    }
    return obj
  };
  ARController.prototype.getMultiMarkerCount = function () {
    return artoolkit.getMultiMarkerCount(this.id)
  };
  ARController.prototype.getMultiMarkerPatternCount = function (multiMarkerId) {
    return artoolkit.getMultiMarkerNum(this.id, multiMarkerId)
  };
  ARController.prototype.addEventListener = function (name, callback) {
    if (!this.listeners[name]) {
      this.listeners[name] = []
    }
    this.listeners[name].push(callback)
  };
  ARController.prototype.removeEventListener = function (name, callback) {
    if (this.listeners[name]) {
      var index = this.listeners[name].indexOf(callback);
      if (index > -1) {
        this.listeners[name].splice(index, 1)
      }
    }
  };
  ARController.prototype.dispatchEvent = function (event) {
    var listeners = this.listeners[event.name];
    if (listeners) {
      for (var i = 0; i < listeners.length; i++) {
        listeners[i].call(this, event)
      }
    }
  };
  ARController.prototype.debugSetup = function () {
    document.body.appendChild(this.canvas);
    var lumaCanvas = document.createElement("canvas");
    lumaCanvas.width = this.canvas.width;
    lumaCanvas.height = this.canvas.height;
    this._lumaCtx = lumaCanvas.getContext("2d");
    document.body.appendChild(lumaCanvas);
    this.setDebugMode(true);
    this._bwpointer = this.getProcessingImage()
  };
  ARController.prototype.loadMarker = function (markerURL, onSuccess, onError) {
    if (markerURL) {
      artoolkit.addMarker(this.id, markerURL, onSuccess, onError)
    } else {
      if (onError) {
        onError("Marker URL needs to be defined and not equal empty string!")
      } else {
        console.error("Marker URL needs to be defined and not equal empty string!")
      }
    }
  };
  ARController.prototype.loadNFTMarker = function (markerURL, onSuccess, onError) {
    var self = this;
    return artoolkit.addNFTMarker(this.id, markerURL, function (id) {
      self.nftMarkerCount = id + 1;
      onSuccess(id)
    }, onError)
  };
  ARController.prototype.loadMultiMarker = function (markerURL, onSuccess, onError) {
    return artoolkit.addMultiMarker(this.id, markerURL, onSuccess, onError)
  };
  ARController.prototype.getTransMatSquare = function (markerUID, markerWidth, dst) {
    artoolkit.getTransMatSquare(this.id, markerUID, markerWidth);
    dst.set(this.marker_transform_mat);
    return dst
  };
  ARController.prototype.getTransMatSquareCont = function (markerUID, markerWidth, previousMarkerTransform, dst) {
    this.marker_transform_mat.set(previousMarkerTransform);
    artoolkit.getTransMatSquareCont(this.id, markerUID, markerWidth);
    dst.set(this.marker_transform_mat);
    return dst
  };
  ARController.prototype.getTransMatMultiSquare = function (markerUID, dst) {
    artoolkit.getTransMatMultiSquare(this.id, markerUID);
    dst.set(this.marker_transform_mat);
    return dst
  };
  ARController.prototype.getTransMatMultiSquareRobust = function (markerUID, dst) {
    artoolkit.getTransMatMultiSquare(this.id, markerUID);
    dst.set(this.marker_transform_mat);
    return dst
  };
  ARController.prototype.transMatToGLMat = function (transMat, glMat, scale) {
    if (glMat == undefined) {
      glMat = new Float64Array(16)
    }
    glMat[0 + 0 * 4] = transMat[0];
    glMat[0 + 1 * 4] = transMat[1];
    glMat[0 + 2 * 4] = transMat[2];
    glMat[0 + 3 * 4] = transMat[3];
    glMat[1 + 0 * 4] = transMat[4];
    glMat[1 + 1 * 4] = transMat[5];
    glMat[1 + 2 * 4] = transMat[6];
    glMat[1 + 3 * 4] = transMat[7];
    glMat[2 + 0 * 4] = transMat[8];
    glMat[2 + 1 * 4] = transMat[9];
    glMat[2 + 2 * 4] = transMat[10];
    glMat[2 + 3 * 4] = transMat[11];
    glMat[3 + 0 * 4] = 0;
    glMat[3 + 1 * 4] = 0;
    glMat[3 + 2 * 4] = 0;
    glMat[3 + 3 * 4] = 1;
    if (scale != undefined && scale !== 0) {
      glMat[12] *= scale;
      glMat[13] *= scale;
      glMat[14] *= scale
    }
    return glMat
  };
  ARController.prototype.arglCameraViewRHf = function (glMatrix, glRhMatrix, scale) {
    var m_modelview;
    if (glRhMatrix == undefined) m_modelview = new Float64Array(16);
    else m_modelview = glRhMatrix;
    m_modelview[0] = glMatrix[0];
    m_modelview[4] = glMatrix[4];
    m_modelview[8] = glMatrix[8];
    m_modelview[12] = glMatrix[12];
    m_modelview[1] = -glMatrix[1];
    m_modelview[5] = -glMatrix[5];
    m_modelview[9] = -glMatrix[9];
    m_modelview[13] = -glMatrix[13];
    m_modelview[2] = -glMatrix[2];
    m_modelview[6] = -glMatrix[6];
    m_modelview[10] = -glMatrix[10];
    m_modelview[14] = -glMatrix[14];
    m_modelview[3] = 0;
    m_modelview[7] = 0;
    m_modelview[11] = 0;
    m_modelview[15] = 1;
    if (scale != undefined && scale !== 0) {
      m_modelview[12] *= scale;
      m_modelview[13] *= scale;
      m_modelview[14] *= scale
    }
    glRhMatrix = m_modelview;
    return glRhMatrix
  };
  ARController.prototype.detectMarker = function (image) {
    if (this._copyImageToHeap(image)) {
      return artoolkit.detectMarker(this.id)
    }
    return -99
  };
  ARController.prototype.getMarkerNum = function () {
    return artoolkit.getMarkerNum(this.id)
  };
  ARController.prototype.getMarker = function (markerIndex) {
    if (0 === artoolkit.getMarker(this.id, markerIndex)) {
      return artoolkit.markerInfo
    }
  };
  ARController.prototype.getNFTMarker = function (markerIndex) {
    if (0 === artoolkit.getNFTMarker(this.id, markerIndex)) {
      return artoolkit.NFTMarkerInfo
    }
  };
  ARController.prototype.setMarkerInfoVertex = function (markerIndex, vertexData) {
    for (var i = 0; i < vertexData.length; i++) {
      this.marker_transform_mat[i * 2 + 0] = vertexData[i][0];
      this.marker_transform_mat[i * 2 + 1] = vertexData[i][1]
    }
    return artoolkit.setMarkerInfoVertex(this.id, markerIndex)
  };
  ARController.prototype.cloneMarkerInfo = function (markerInfo) {
    return JSON.parse(JSON.stringify(markerInfo))
  };
  ARController.prototype.getMultiEachMarker = function (multiMarkerId, markerIndex) {
    if (0 === artoolkit.getMultiEachMarker(this.id, multiMarkerId, markerIndex)) {
      return artoolkit.multiEachMarkerInfo
    }
  };
  ARController.prototype.getTransformationMatrix = function () {
    return this.transform_mat
  };
  ARController.prototype.getCameraMatrix = function () {
    return this.camera_mat
  };
  ARController.prototype.getMarkerTransformationMatrix = function () {
    return this.marker_transform_mat
  };
  ARController.prototype.setDebugMode = function (mode) {
    return artoolkit.setDebugMode(this.id, mode)
  };
  ARController.prototype.getDebugMode = function () {
    return artoolkit.getDebugMode(this.id)
  };
  ARController.prototype.getProcessingImage = function () {
    return artoolkit.getProcessingImage(this.id)
  };
  ARController.prototype.setLogLevel = function (mode) {
    return artoolkit.setLogLevel(mode)
  };
  ARController.prototype.getLogLevel = function () {
    return artoolkit.getLogLevel()
  };
  ARController.prototype.setMarkerInfoDir = function (markerIndex, dir) {
    return artoolkit.setMarkerInfoDir(this.id, markerIndex, dir)
  };
  ARController.prototype.setProjectionNearPlane = function (value) {
    return artoolkit.setProjectionNearPlane(this.id, value)
  };
  ARController.prototype.getProjectionNearPlane = function () {
    return artoolkit.getProjectionNearPlane(this.id)
  };
  ARController.prototype.setProjectionFarPlane = function (value) {
    return artoolkit.setProjectionFarPlane(this.id, value)
  };
  ARController.prototype.getProjectionFarPlane = function () {
    return artoolkit.getProjectionFarPlane(this.id)
  };
  ARController.prototype.setThresholdMode = function (mode) {
    return artoolkit.setThresholdMode(this.id, mode)
  };
  ARController.prototype.getThresholdMode = function () {
    return artoolkit.getThresholdMode(this.id)
  };
  ARController.prototype.setThreshold = function (threshold) {
    return artoolkit.setThreshold(this.id, threshold)
  };
  ARController.prototype.getThreshold = function () {
    return artoolkit.getThreshold(this.id)
  };
  ARController.prototype.setPatternDetectionMode = function (value) {
    return artoolkit.setPatternDetectionMode(this.id, value)
  };
  ARController.prototype.getPatternDetectionMode = function () {
    return artoolkit.getPatternDetectionMode(this.id)
  };
  ARController.prototype.setMatrixCodeType = function (value) {
    return artoolkit.setMatrixCodeType(this.id, value)
  };
  ARController.prototype.getMatrixCodeType = function () {
    return artoolkit.getMatrixCodeType(this.id)
  };
  ARController.prototype.setLabelingMode = function (value) {
    return artoolkit.setLabelingMode(this.id, value)
  };
  ARController.prototype.getLabelingMode = function () {
    return artoolkit.getLabelingMode(this.id)
  };
  ARController.prototype.setPattRatio = function (value) {
    return artoolkit.setPattRatio(this.id, value)
  };
  ARController.prototype.getPattRatio = function () {
    return artoolkit.getPattRatio(this.id)
  };
  ARController.prototype.setImageProcMode = function (value) {
    return artoolkit.setImageProcMode(this.id, value)
  };
  ARController.prototype.getImageProcMode = function () {
    return artoolkit.getImageProcMode(this.id)
  };
  ARController.prototype.debugDraw = function () {
    var debugBuffer = new Uint8ClampedArray(Module.HEAPU8.buffer, this._bwpointer, this.framesize);
    var id = new ImageData(new Uint8ClampedArray(this.canvas.width * this.canvas.height * 4), this.canvas.width, this.canvas.height);
    for (var i = 0, j = 0; i < debugBuffer.length; i++, j += 4) {
      var v = debugBuffer[i];
      id.data[j + 0] = v;
      id.data[j + 1] = v;
      id.data[j + 2] = v;
      id.data[j + 3] = 255
    }
    this.ctx.putImageData(id, 0, 0);
    var lumaBuffer = new Uint8ClampedArray(this.framesize);
    lumaBuffer.set(this.videoLuma);
    var lumaImageData = new ImageData(lumaBuffer, this.videoWidth, this.videoHeight);
    this._lumaCtx.putImageData(lumaImageData, 0, 0);
    var marker_num = this.getMarkerNum();
    for (var i = 0; i < marker_num; i++) {
      this._debugMarker(this.getMarker(i))
    }
    if (this.transform_mat && this.transformGL_RH) {
      console.log("GL 4x4 Matrix: " + this.transform_mat);
      console.log("GL_RH 4x4 Mat: " + this.transformGL_RH)
    }
  };
  ARController.prototype._initialize = function () {
    this.id = artoolkit.setup(this.canvas.width, this.canvas.height, this.cameraParam.id);
    this._initNFT();
    var params = artoolkit.frameMalloc;
    this.framepointer = params.framepointer;
    this.framesize = params.framesize;
    this.videoLumaPointer = params.videoLumaPointer;
    this.dataHeap = new Uint8Array(Module.HEAPU8.buffer, this.framepointer, this.framesize);
    this.videoLuma = new Uint8Array(Module.HEAPU8.buffer, this.videoLumaPointer, this.framesize / 4);
    this.camera_mat = new Float64Array(Module.HEAPU8.buffer, params.camera, 16);
    this.marker_transform_mat = new Float64Array(Module.HEAPU8.buffer, params.transform, 12);
    this.setProjectionNearPlane(.1);
    this.setProjectionFarPlane(1e3);
    setTimeout(function () {
      if (this.onload) {
        this.onload()
      }
      this.dispatchEvent({
        name: "load",
        target: this
      })
    }.bind(this), 1)
  };
  ARController.prototype._initNFT = function () {
    artoolkit.setupAR2(this.id)
  };
  ARController.prototype._copyImageToHeap = function (image) {
    if (!image) {
      image = this.image
    }
    this.ctx.save();
    if (this.orientation === "portrait") {
      this.ctx.translate(this.canvas.width, 0);
      this.ctx.rotate(Math.PI / 2);
      this.ctx.drawImage(image, 0, 0, this.canvas.height, this.canvas.width)
    } else {
      this.ctx.drawImage(image, 0, 0, this.canvas.width, this.canvas.height)
    }
    this.ctx.restore();
    var imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    var data = imageData.data;
    if (this.videoLuma) {
      var q = 0;
      for (var p = 0; p < this.videoSize; p++) {
        var r = data[q + 0],
          g = data[q + 1],
          b = data[q + 2];
        this.videoLuma[p] = r + r + r + b + g + g + g + g >> 3;
        q += 4
      }
    }
    if (this.dataHeap) {
      this.dataHeap.set(data);
      return true
    }
    return false
  };
  ARController.prototype._debugMarker = function (marker) {
    var vertex, pos;
    vertex = marker.vertex;
    var ctx = this.ctx;
    ctx.strokeStyle = "red";
    ctx.beginPath();
    ctx.moveTo(vertex[0][0], vertex[0][1]);
    ctx.lineTo(vertex[1][0], vertex[1][1]);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(vertex[2][0], vertex[2][1]);
    ctx.lineTo(vertex[3][0], vertex[3][1]);
    ctx.stroke();
    ctx.strokeStyle = "green";
    ctx.beginPath();
    ctx.lineTo(vertex[1][0], vertex[1][1]);
    ctx.lineTo(vertex[2][0], vertex[2][1]);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(vertex[3][0], vertex[3][1]);
    ctx.lineTo(vertex[0][0], vertex[0][1]);
    ctx.stroke();
    pos = marker.pos;
    ctx.beginPath();
    ctx.arc(pos[0], pos[1], 8, 0, Math.PI * 2);
    ctx.fillStyle = "red";
    ctx.fill()
  };
  ARController.getUserMedia = function (configuration) {
    var facing = configuration.facingMode || "environment";
    var onSuccess = configuration.onSuccess;
    var onError = configuration.onError || function (err) {
      console.error("ARController.getUserMedia", err)
    };
    var video = document.createElement("video");
    var readyToPlay = false;
    var eventNames = ["touchstart", "touchend", "touchmove", "touchcancel", "click", "mousedown", "mouseup", "mousemove", "keydown", "keyup", "keypress", "scroll"];
    var play = function () {
      if (readyToPlay) {
        video.play().then(function () {
          onSuccess(video)
        }).catch(function (error) {
          onError(error);
          ARController._teardownVideo(video)
        });
        if (!video.paused) {
          eventNames.forEach(function (eventName) {
            window.removeEventListener(eventName, play, true)
          })
        }
      }
    };
    eventNames.forEach(function (eventName) {
      window.addEventListener(eventName, play, true)
    });
    var success = function (stream) {
      if (window.URL.createObjectURL) {
        try {
          video.srcObject = stream
        } catch (ex) {}
      }
      video.srcObject = stream;
      readyToPlay = true;
      video.autoplay = true;
      video.playsInline = true;
      play()
    };
    var constraints = {};
    var mediaDevicesConstraints = {};
    if (configuration.width) {
      mediaDevicesConstraints.width = configuration.width;
      if (typeof configuration.width === "object") {
        if (configuration.width.max) {
          constraints.maxWidth = configuration.width.max
        }
        if (configuration.width.min) {
          constraints.minWidth = configuration.width.min
        }
      } else {
        constraints.maxWidth = configuration.width
      }
    }
    if (configuration.height) {
      mediaDevicesConstraints.height = configuration.height;
      if (typeof configuration.height === "object") {
        if (configuration.height.max) {
          constraints.maxHeight = configuration.height.max
        }
        if (configuration.height.min) {
          constraints.minHeight = configuration.height.min
        }
      } else {
        constraints.maxHeight = configuration.height
      }
    }
    mediaDevicesConstraints.facingMode = facing;
    mediaDevicesConstraints.deviceId = configuration.deviceId;
    navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
    var hdConstraints = {
      audio: false,
      video: constraints
    };
    if (navigator.mediaDevices || window.MediaStreamTrack.getSources) {
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: mediaDevicesConstraints
        }).then(success, onError)
      } else {
        window.MediaStreamTrack.getSources(function (sources) {
          var facingDir = mediaDevicesConstraints.facingMode;
          if (facing && facing.exact) {
            facingDir = facing.exact
          }
          for (var i = 0; i < sources.length; i++) {
            if (sources[i].kind === "video" && sources[i].facing === facingDir) {
              hdConstraints.video.mandatory.sourceId = sources[i].id;
              break
            }
          }
          if (facing && facing.exact && !hdConstraints.video.mandatory.sourceId) {
            onError("Failed to get camera facing the wanted direction")
          } else {
            if (navigator.getUserMedia) {
              navigator.getUserMedia(hdConstraints, success, onError)
            } else {
              onError("navigator.getUserMedia is not supported on your browser")
            }
          }
        })
      }
    } else {
      if (navigator.getUserMedia) {
        navigator.getUserMedia(hdConstraints, success, onError)
      } else {
        onError("navigator.getUserMedia is not supported on your browser")
      }
    }
    return video
  };
  ARController.getUserMediaARController = function (configuration) {
    var obj = {};
    for (var i in configuration) {
      obj[i] = configuration[i]
    }
    var onSuccess = configuration.onSuccess;
    var cameraParamURL = configuration.cameraParam;
    var onError = configuration.onError || function (err) {
      console.error("ARController: Failed to load ARCameraParam", err)
    };
    obj.onSuccess = function () {
      new ARCameraParam(cameraParamURL, function () {
        var arCameraParam = this;
        var maxSize = configuration.maxARVideoSize || Math.max(video.videoWidth, video.videoHeight);
        var f = maxSize / Math.max(video.videoWidth, video.videoHeight);
        var w = f * video.videoWidth;
        var h = f * video.videoHeight;
        if (video.videoWidth < video.videoHeight) {
          var tmp = w;
          w = h;
          h = tmp
        }
        var arController = new ARController(w, h, arCameraParam);
        arController.image = video;
        if (video.videoWidth < video.videoHeight) {
          arController.orientation = "portrait";
          arController.videoWidth = video.videoHeight;
          arController.videoHeight = video.videoWidth
        } else {
          arController.orientation = "landscape";
          arController.videoWidth = video.videoWidth;
          arController.videoHeight = video.videoHeight
        }
        onSuccess(arController, arCameraParam)
      }, function (err) {
        ARController._teardownVideo(video);
        onError(err)
      })
    };
    var video = ARController.getUserMedia(obj);
    return video
  };
  ARController._teardownVideo = function (video) {
    video.srcObject.getVideoTracks()[0].stop();
    video.srcObject = null;
    video.src = null
  };
  var ARCameraParam = function (src, onload, onerror) {
    this.id = -1;
    this._src = "";
    this.complete = false;
    if (!onload) {
      this.onload = function () {
        console.log("Successfully loaded")
      };
      console.warn("onload callback should be defined")
    } else {
      this.onload = onload
    }
    if (!onerror) {
      this.onerror = function (err) {
        console.error("Error: " + err)
      };
      console.warn("onerror callback should be defined")
    } else {
      this.onerror = onerror
    }
    if (src) {
      this.load(src)
    } else {
      console.warn("No camera parameter file defined! It should be defined in constructor or in ARCameraParam.load(url)")
    }
  };
  ARCameraParam.prototype.load = function (src) {
    if (this._src !== "") {
      throw "ARCameraParam: Trying to load camera parameters twice."
    }
    this._src = src;
    if (src) {
      artoolkit.loadCamera(src, function (id) {
        this.id = id;
        this.complete = true;
        this.onload()
      }.bind(this), function (err) {
        this.onerror(err)
      }.bind(this))
    }
  };
  Object.defineProperty(ARCameraParam.prototype, "src", {
    set: function (src) {
      this.load(src)
    },
    get: function () {
      return this._src
    }
  });
  ARCameraParam.prototype.dispose = function () {
    if (this.id !== -1) {
      artoolkit.deleteCamera(this.id)
    }
    this.id = -1;
    this._src = "";
    this.complete = false
  };
  var artoolkit = {
    UNKNOWN_MARKER: -1,
    PATTERN_MARKER: 0,
    BARCODE_MARKER: 1,
    loadCamera: loadCamera,
    addMarker: addMarker,
    addMultiMarker: addMultiMarker,
    addNFTMarker: addNFTMarker
  };
  var FUNCTIONS = ["setup", "teardown", "setupAR2", "setLogLevel", "getLogLevel", "setDebugMode", "getDebugMode", "getProcessingImage", "setMarkerInfoDir", "setMarkerInfoVertex", "getTransMatSquare", "getTransMatSquareCont", "getTransMatMultiSquare", "getTransMatMultiSquareRobust", "getMultiMarkerNum", "getMultiMarkerCount", "detectMarker", "getMarkerNum", "detectNFTMarker", "getMarker", "getMultiEachMarker", "getNFTMarker", "setProjectionNearPlane", "getProjectionNearPlane", "setProjectionFarPlane", "getProjectionFarPlane", "setThresholdMode", "getThresholdMode", "setThreshold", "getThreshold", "setPatternDetectionMode", "getPatternDetectionMode", "setMatrixCodeType", "getMatrixCodeType", "setLabelingMode", "getLabelingMode", "setPattRatio", "getPattRatio", "setImageProcMode", "getImageProcMode"];

  function runWhenLoaded() {
    FUNCTIONS.forEach(function (n) {
      artoolkit[n] = Module[n]
    });
    for (var m in Module) {
      if (m.match(/^AR/)) artoolkit[m] = Module[m]
    }
  }
  var marker_count = 0;

  function addMarker(arId, url, callback, onError) {
    var filename = "/marker_" + marker_count++;
    ajax(url, filename, function () {
      var id = Module._addMarker(arId, filename);
      if (callback) callback(id)
    }, function (errorNumber) {
      if (onError) onError(errorNumber)
    })
  }

  function addNFTMarker(arId, url, callback) {
    var mId = marker_count++;
    var prefix = "/markerNFT_" + mId;
    var filename1 = prefix + ".fset";
    var filename2 = prefix + ".iset";
    var filename3 = prefix + ".fset3";
    ajax(url + ".fset", filename1, function () {
      ajax(url + ".iset", filename2, function () {
        ajax(url + ".fset3", filename3, function () {
          var id = Module._addNFTMarker(arId, prefix);
          if (callback) callback(id)
        })
      })
    })
  }

  function bytesToString(array) {
    return String.fromCharCode.apply(String, array)
  }

  function parseMultiFile(bytes) {
    var str = bytesToString(bytes);
    var lines = str.split("\n");
    var files = [];
    var state = 0;
    var markers = 0;
    lines.forEach(function (line) {
      line = line.trim();
      if (!line || line.startsWith("#")) return;
      switch (state) {
      case 0:
        markers = +line;
        state = 1;
        return;
      case 1:
        if (!line.match(/^\d+$/)) {
          files.push(line)
        }
      case 2:
      case 3:
      case 4:
        state++;
        return;
      case 5:
        state = 1;
        return
      }
    });
    return files
  }
  var multi_marker_count = 0;

  function addMultiMarker(arId, url, callback, onError) {
    var filename = "/multi_marker_" + multi_marker_count++;
    ajax(url, filename, function (bytes) {
      var files = parseMultiFile(bytes);

      function ok() {
        var markerID = Module._addMultiMarker(arId, filename);
        var markerNum = Module.getMultiMarkerNum(arId, markerID);
        if (callback) callback(markerID, markerNum)
      }
      if (!files.length) return ok();
      var path = url.split("/").slice(0, -1).join("/");
      files = files.map(function (file) {
        return [path + "/" + file, file]
      });
      ajaxDependencies(files, ok)
    }, function (error) {
      if (onError) onError(error)
    })
  }
  var camera_count = 0;

  function loadCamera(url, callback, errorCallback) {
    var filename = "/camera_param_" + camera_count++;
    var writeCallback = function (errorCode) {
      if (!Module._loadCamera) {
        if (callback) callback(id);
        setTimeout(writeCallback, 10)
      } else {
        var id = Module._loadCamera(filename);
        if (callback) callback(id)
      }
    };
    if (typeof url === "object") {
      writeByteArrayToFS(filename, url, writeCallback)
    } else if (url.indexOf("\n") > -1) {
      writeStringToFS(filename, url, writeCallback)
    } else {
      ajax(url, filename, writeCallback, errorCallback)
    }
  }

  function writeStringToFS(target, string, callback) {
    var byteArray = new Uint8Array(string.length);
    for (var i = 0; i < byteArray.length; i++) {
      byteArray[i] = string.charCodeAt(i) & 255
    }
    writeByteArrayToFS(target, byteArray, callback)
  }

  function writeByteArrayToFS(target, byteArray, callback) {
    FS.writeFile(target, byteArray, {
      encoding: "binary"
    });
    callback(byteArray)
  }

  function ajax(url, target, callback, errorCallback) {
    var oReq = new XMLHttpRequest;
    oReq.open("GET", url, true);
    oReq.responseType = "arraybuffer";
    oReq.onload = function () {
      if (this.status == 200) {
        var arrayBuffer = oReq.response;
        var byteArray = new Uint8Array(arrayBuffer);
        writeByteArrayToFS(target, byteArray, callback)
      } else {
        errorCallback(this.status)
      }
    };
    oReq.send()
  }

  function ajaxDependencies(files, callback) {
    var next = files.pop();
    if (next) {
      ajax(next[0], next[1], function () {
        ajaxDependencies(files, callback)
      })
    } else {
      callback()
    }
  }
  window.artoolkit = artoolkit;
  window.ARController = ARController;
  window.ARCameraParam = ARCameraParam;
  if (window.Module) {
    window.Module.onRuntimeInitialized = function () {
      runWhenLoaded();
      var event = new Event("artoolkit-loaded");
      window.dispatchEvent(event)
    }
  } else {
    window.Module = {
      onRuntimeInitialized: function () {
        runWhenLoaded()
      }
    }
  }
})();
var moduleOverrides = {};
var key;
for (key in Module) {
  if (Module.hasOwnProperty(key)) {
    moduleOverrides[key] = Module[key]
  }
}
Module["arguments"] = [];
Module["thisProgram"] = "./this.program";
Module["quit"] = function (status, toThrow) {
  throw toThrow
};
Module["preRun"] = [];
Module["postRun"] = [];
var ENVIRONMENT_IS_WEB = false;
var ENVIRONMENT_IS_WORKER = false;
var ENVIRONMENT_IS_NODE = false;
var ENVIRONMENT_IS_SHELL = false;
ENVIRONMENT_IS_WEB = typeof window === "object";
ENVIRONMENT_IS_WORKER = typeof importScripts === "function";
ENVIRONMENT_IS_NODE = typeof process === "object" && typeof require === "function" && !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_WORKER;
ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;
var scriptDirectory = "";

function locateFile(path) {
  if (Module["locateFile"]) {
    return Module["locateFile"](path, scriptDirectory)
  } else {
    return scriptDirectory + path
  }
}
if (ENVIRONMENT_IS_NODE) {
  scriptDirectory = __dirname + "/";
  var nodeFS;
  var nodePath;
  Module["read"] = function shell_read(filename, binary) {
    var ret;
    if (!nodeFS) nodeFS = require("fs");
    if (!nodePath) nodePath = require("path");
    filename = nodePath["normalize"](filename);
    ret = nodeFS["readFileSync"](filename);
    return binary ? ret : ret.toString()
  };
  Module["readBinary"] = function readBinary(filename) {
    var ret = Module["read"](filename, true);
    if (!ret.buffer) {
      ret = new Uint8Array(ret)
    }
    assert(ret.buffer);
    return ret
  };
  if (process["argv"].length > 1) {
    Module["thisProgram"] = process["argv"][1].replace(/\\/g, "/")
  }
  Module["arguments"] = process["argv"].slice(2);
  if (typeof module !== "undefined") {
    module["exports"] = Module
  }
  process["on"]("uncaughtException", function (ex) {
    if (!(ex instanceof ExitStatus)) {
      throw ex
    }
  });
  process["on"]("unhandledRejection", abort);
  Module["quit"] = function (status) {
    process["exit"](status)
  };
  Module["inspect"] = function () {
    return "[Emscripten Module object]"
  }
} else if (ENVIRONMENT_IS_SHELL) {
  if (typeof read != "undefined") {
    Module["read"] = function shell_read(f) {
      return read(f)
    }
  }
  Module["readBinary"] = function readBinary(f) {
    var data;
    if (typeof readbuffer === "function") {
      return new Uint8Array(readbuffer(f))
    }
    data = read(f, "binary");
    assert(typeof data === "object");
    return data
  };
  if (typeof scriptArgs != "undefined") {
    Module["arguments"] = scriptArgs
  } else if (typeof arguments != "undefined") {
    Module["arguments"] = arguments
  }
  if (typeof quit === "function") {
    Module["quit"] = function (status) {
      quit(status)
    }
  }
} else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
  if (ENVIRONMENT_IS_WORKER) {
    scriptDirectory = self.location.href
  } else if (document.currentScript) {
    scriptDirectory = document.currentScript.src
  }
  if (scriptDirectory.indexOf("blob:") !== 0) {
    scriptDirectory = scriptDirectory.substr(0, scriptDirectory.lastIndexOf("/") + 1)
  } else {
    scriptDirectory = ""
  }
  Module["read"] = function shell_read(url) {
    var xhr = new XMLHttpRequest;
    xhr.open("GET", url, false);
    xhr.send(null);
    return xhr.responseText
  };
  if (ENVIRONMENT_IS_WORKER) {
    Module["readBinary"] = function readBinary(url) {
      var xhr = new XMLHttpRequest;
      xhr.open("GET", url, false);
      xhr.responseType = "arraybuffer";
      xhr.send(null);
      return new Uint8Array(xhr.response)
    }
  }
  Module["readAsync"] = function readAsync(url, onload, onerror) {
    var xhr = new XMLHttpRequest;
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = function xhr_onload() {
      if (xhr.status == 200 || xhr.status == 0 && xhr.response) {
        onload(xhr.response);
        return
      }
      onerror()
    };
    xhr.onerror = onerror;
    xhr.send(null)
  };
  Module["setWindowTitle"] = function (title) {
    document.title = title
  }
} else {}
var out = Module["print"] || (typeof console !== "undefined" ? console.log.bind(console) : typeof print !== "undefined" ? print : null);
var err = Module["printErr"] || (typeof printErr !== "undefined" ? printErr : typeof console !== "undefined" && console.warn.bind(console) || out);
for (key in moduleOverrides) {
  if (moduleOverrides.hasOwnProperty(key)) {
    Module[key] = moduleOverrides[key]
  }
}
moduleOverrides = undefined;

function dynamicAlloc(size) {
  var ret = HEAP32[DYNAMICTOP_PTR >> 2];
  var end = ret + size + 15 & -16;
  if (end <= _emscripten_get_heap_size()) {
    HEAP32[DYNAMICTOP_PTR >> 2] = end
  } else {
    return 0
  }
  return ret
}

function getNativeTypeSize(type) {
  switch (type) {
  case "i1":
  case "i8":
    return 1;
  case "i16":
    return 2;
  case "i32":
    return 4;
  case "i64":
    return 8;
  case "float":
    return 4;
  case "double":
    return 8;
  default:
    {
      if (type[type.length - 1] === "*") {
        return 4
      } else if (type[0] === "i") {
        var bits = parseInt(type.substr(1));
        assert(bits % 8 === 0, "getNativeTypeSize invalid bits " + bits + ", type " + type);
        return bits / 8
      } else {
        return 0
      }
    }
  }
}
var asm2wasmImports = {
  "f64-rem": function (x, y) {
    return x % y
  },
  "debugger": function () {
    debugger
  }
};
var functionPointers = new Array(0);
var tempRet0 = 0;
var setTempRet0 = function (value) {
  tempRet0 = value
};
var getTempRet0 = function () {
  return tempRet0
};
if (typeof WebAssembly !== "object") {
  err("no native wasm support detected")
}
var wasmMemory;
var wasmTable;
var ABORT = false;
var EXITSTATUS = 0;

function assert(condition, text) {
  if (!condition) {
    abort("Assertion failed: " + text)
  }
}

function setValue(ptr, value, type, noSafe) {
  type = type || "i8";
  if (type.charAt(type.length - 1) === "*") type = "i32";
  switch (type) {
  case "i1":
    HEAP8[ptr >> 0] = value;
    break;
  case "i8":
    HEAP8[ptr >> 0] = value;
    break;
  case "i16":
    HEAP16[ptr >> 1] = value;
    break;
  case "i32":
    HEAP32[ptr >> 2] = value;
    break;
  case "i64":
    tempI64 = [value >>> 0, (tempDouble = value, +Math_abs(tempDouble) >= 1 ? tempDouble > 0 ? (Math_min(+Math_floor(tempDouble / 4294967296), 4294967295) | 0) >>> 0 : ~~+Math_ceil((tempDouble - +(~~tempDouble >>> 0)) / 4294967296) >>> 0 : 0)], HEAP32[ptr >> 2] = tempI64[0], HEAP32[ptr + 4 >> 2] = tempI64[1];
    break;
  case "float":
    HEAPF32[ptr >> 2] = value;
    break;
  case "double":
    HEAPF64[ptr >> 3] = value;
    break;
  default:
    abort("invalid type for setValue: " + type)
  }
}
var ALLOC_NORMAL = 0;
var ALLOC_NONE = 3;

function allocate(slab, types, allocator, ptr) {
  var zeroinit, size;
  if (typeof slab === "number") {
    zeroinit = true;
    size = slab
  } else {
    zeroinit = false;
    size = slab.length
  }
  var singleType = typeof types === "string" ? types : null;
  var ret;
  if (allocator == ALLOC_NONE) {
    ret = ptr
  } else {
    ret = [_malloc, stackAlloc, dynamicAlloc][allocator](Math.max(size, singleType ? 1 : types.length))
  }
  if (zeroinit) {
    var stop;
    ptr = ret;
    assert((ret & 3) == 0);
    stop = ret + (size & ~3);
    for (; ptr < stop; ptr += 4) {
      HEAP32[ptr >> 2] = 0
    }
    stop = ret + size;
    while (ptr < stop) {
      HEAP8[ptr++ >> 0] = 0
    }
    return ret
  }
  if (singleType === "i8") {
    if (slab.subarray || slab.slice) {
      HEAPU8.set(slab, ret)
    } else {
      HEAPU8.set(new Uint8Array(slab), ret)
    }
    return ret
  }
  var i = 0,
    type, typeSize, previousType;
  while (i < size) {
    var curr = slab[i];
    type = singleType || types[i];
    if (type === 0) {
      i++;
      continue
    }
    if (type == "i64") type = "i32";
    setValue(ret + i, curr, type);
    if (previousType !== type) {
      typeSize = getNativeTypeSize(type);
      previousType = type
    }
    i += typeSize
  }
  return ret
}

function getMemory(size) {
  if (!runtimeInitialized) return dynamicAlloc(size);
  return _malloc(size)
}
var UTF8Decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf8") : undefined;

function UTF8ArrayToString(u8Array, idx, maxBytesToRead) {
  var endIdx = idx + maxBytesToRead;
  var endPtr = idx;
  while (u8Array[endPtr] && !(endPtr >= endIdx)) ++endPtr;
  if (endPtr - idx > 16 && u8Array.subarray && UTF8Decoder) {
    return UTF8Decoder.decode(u8Array.subarray(idx, endPtr))
  } else {
    var str = "";
    while (idx < endPtr) {
      var u0 = u8Array[idx++];
      if (!(u0 & 128)) {
        str += String.fromCharCode(u0);
        continue
      }
      var u1 = u8Array[idx++] & 63;
      if ((u0 & 224) == 192) {
        str += String.fromCharCode((u0 & 31) << 6 | u1);
        continue
      }
      var u2 = u8Array[idx++] & 63;
      if ((u0 & 240) == 224) {
        u0 = (u0 & 15) << 12 | u1 << 6 | u2
      } else {
        u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | u8Array[idx++] & 63
      }
      if (u0 < 65536) {
        str += String.fromCharCode(u0)
      } else {
        var ch = u0 - 65536;
        str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023)
      }
    }
  }
  return str
}

function UTF8ToString(ptr, maxBytesToRead) {
  return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : ""
}

function stringToUTF8Array(str, outU8Array, outIdx, maxBytesToWrite) {
  if (!(maxBytesToWrite > 0)) return 0;
  var startIdx = outIdx;
  var endIdx = outIdx + maxBytesToWrite - 1;
  for (var i = 0; i < str.length; ++i) {
    var u = str.charCodeAt(i);
    if (u >= 55296 && u <= 57343) {
      var u1 = str.charCodeAt(++i);
      u = 65536 + ((u & 1023) << 10) | u1 & 1023
    }
    if (u <= 127) {
      if (outIdx >= endIdx) break;
      outU8Array[outIdx++] = u
    } else if (u <= 2047) {
      if (outIdx + 1 >= endIdx) break;
      outU8Array[outIdx++] = 192 | u >> 6;
      outU8Array[outIdx++] = 128 | u & 63
    } else if (u <= 65535) {
      if (outIdx + 2 >= endIdx) break;
      outU8Array[outIdx++] = 224 | u >> 12;
      outU8Array[outIdx++] = 128 | u >> 6 & 63;
      outU8Array[outIdx++] = 128 | u & 63
    } else {
      if (outIdx + 3 >= endIdx) break;
      outU8Array[outIdx++] = 240 | u >> 18;
      outU8Array[outIdx++] = 128 | u >> 12 & 63;
      outU8Array[outIdx++] = 128 | u >> 6 & 63;
      outU8Array[outIdx++] = 128 | u & 63
    }
  }
  outU8Array[outIdx] = 0;
  return outIdx - startIdx
}

function stringToUTF8(str, outPtr, maxBytesToWrite) {
  return stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite)
}

function lengthBytesUTF8(str) {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    var u = str.charCodeAt(i);
    if (u >= 55296 && u <= 57343) u = 65536 + ((u & 1023) << 10) | str.charCodeAt(++i) & 1023;
    if (u <= 127) ++len;
    else if (u <= 2047) len += 2;
    else if (u <= 65535) len += 3;
    else len += 4
  }
  return len
}
var UTF16Decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-16le") : undefined;

function allocateUTF8(str) {
  var size = lengthBytesUTF8(str) + 1;
  var ret = _malloc(size);
  if (ret) stringToUTF8Array(str, HEAP8, ret, size);
  return ret
}

function writeArrayToMemory(array, buffer) {
  HEAP8.set(array, buffer)
}

function writeAsciiToMemory(str, buffer, dontAddNull) {
  for (var i = 0; i < str.length; ++i) {
    HEAP8[buffer++ >> 0] = str.charCodeAt(i)
  }
  if (!dontAddNull) HEAP8[buffer >> 0] = 0
}

function demangle(func) {
  return func
}

function demangleAll(text) {
  var regex = /__Z[\w\d_]+/g;
  return text.replace(regex, function (x) {
    var y = demangle(x);
    return x === y ? x : y + " [" + x + "]"
  })
}

function jsStackTrace() {
  var err = new Error;
  if (!err.stack) {
    try {
      throw new Error(0)
    } catch (e) {
      err = e
    }
    if (!err.stack) {
      return "(no stack trace available)"
    }
  }
  return err.stack.toString()
}

function stackTrace() {
  var js = jsStackTrace();
  if (Module["extraStackTrace"]) js += "\n" + Module["extraStackTrace"]();
  return demangleAll(js)
}
var WASM_PAGE_SIZE = 65536;
var buffer, HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;

function updateGlobalBufferViews() {
  Module["HEAP8"] = HEAP8 = new Int8Array(buffer);
  Module["HEAP16"] = HEAP16 = new Int16Array(buffer);
  Module["HEAP32"] = HEAP32 = new Int32Array(buffer);
  Module["HEAPU8"] = HEAPU8 = new Uint8Array(buffer);
  Module["HEAPU16"] = HEAPU16 = new Uint16Array(buffer);
  Module["HEAPU32"] = HEAPU32 = new Uint32Array(buffer);
  Module["HEAPF32"] = HEAPF32 = new Float32Array(buffer);
  Module["HEAPF64"] = HEAPF64 = new Float64Array(buffer)
}
var DYNAMIC_BASE = 5302112,
  DYNAMICTOP_PTR = 59200;
var TOTAL_STACK = 5242880;
var INITIAL_TOTAL_MEMORY = Module["TOTAL_MEMORY"] || 268435456;
if (INITIAL_TOTAL_MEMORY < TOTAL_STACK) err("TOTAL_MEMORY should be larger than TOTAL_STACK, was " + INITIAL_TOTAL_MEMORY + "! (TOTAL_STACK=" + TOTAL_STACK + ")");
if (Module["buffer"]) {
  buffer = Module["buffer"]
} else {
  if (typeof WebAssembly === "object" && typeof WebAssembly.Memory === "function") {
    wasmMemory = new WebAssembly.Memory({
      "initial": INITIAL_TOTAL_MEMORY / WASM_PAGE_SIZE,
      "maximum": INITIAL_TOTAL_MEMORY / WASM_PAGE_SIZE
    });
    buffer = wasmMemory.buffer
  } else {
    buffer = new ArrayBuffer(INITIAL_TOTAL_MEMORY)
  }
}
updateGlobalBufferViews();
HEAP32[DYNAMICTOP_PTR >> 2] = DYNAMIC_BASE;

function callRuntimeCallbacks(callbacks) {
  while (callbacks.length > 0) {
    var callback = callbacks.shift();
    if (typeof callback == "function") {
      callback();
      continue
    }
    var func = callback.func;
    if (typeof func === "number") {
      if (callback.arg === undefined) {
        Module["dynCall_v"](func)
      } else {
        Module["dynCall_vi"](func, callback.arg)
      }
    } else {
      func(callback.arg === undefined ? null : callback.arg)
    }
  }
}
var __ATPRERUN__ = [];
var __ATINIT__ = [];
var __ATMAIN__ = [];
var __ATPOSTRUN__ = [];
var runtimeInitialized = false;
var runtimeExited = false;

function preRun() {
  if (Module["preRun"]) {
    if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]];
    while (Module["preRun"].length) {
      addOnPreRun(Module["preRun"].shift())
    }
  }
  callRuntimeCallbacks(__ATPRERUN__)
}

function ensureInitRuntime() {
  if (runtimeInitialized) return;
  runtimeInitialized = true;
  if (!Module["noFSInit"] && !FS.init.initialized) FS.init();
  TTY.init();
  callRuntimeCallbacks(__ATINIT__)
}

function preMain() {
  FS.ignorePermissions = false;
  callRuntimeCallbacks(__ATMAIN__)
}

function exitRuntime() {
  runtimeExited = true
}

function postRun() {
  if (Module["postRun"]) {
    if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]];
    while (Module["postRun"].length) {
      addOnPostRun(Module["postRun"].shift())
    }
  }
  callRuntimeCallbacks(__ATPOSTRUN__)
}

function addOnPreRun(cb) {
  __ATPRERUN__.unshift(cb)
}

function addOnPostRun(cb) {
  __ATPOSTRUN__.unshift(cb)
}
var Math_abs = Math.abs;
var Math_ceil = Math.ceil;
var Math_floor = Math.floor;
var Math_min = Math.min;
var runDependencies = 0;
var runDependencyWatcher = null;
var dependenciesFulfilled = null;

function getUniqueRunDependency(id) {
  return id
}

function addRunDependency(id) {
  runDependencies++;
  if (Module["monitorRunDependencies"]) {
    Module["monitorRunDependencies"](runDependencies)
  }
}

function removeRunDependency(id) {
  runDependencies--;
  if (Module["monitorRunDependencies"]) {
    Module["monitorRunDependencies"](runDependencies)
  }
  if (runDependencies == 0) {
    if (runDependencyWatcher !== null) {
      clearInterval(runDependencyWatcher);
      runDependencyWatcher = null
    }
    if (dependenciesFulfilled) {
      var callback = dependenciesFulfilled;
      dependenciesFulfilled = null;
      callback()
    }
  }
}
Module["preloadedImages"] = {};
Module["preloadedAudios"] = {};
var dataURIPrefix = "data:application/octet-stream;base64,";

function isDataURI(filename) {
  return String.prototype.startsWith ? filename.startsWith(dataURIPrefix) : filename.indexOf(dataURIPrefix) === 0
}
var wasmBinaryFile = "artoolkitNft_wasm.wasm";
if (!isDataURI(wasmBinaryFile)) {
  wasmBinaryFile = locateFile(wasmBinaryFile)
}

function getBinary() {
  try {
    if (Module["wasmBinary"]) {
      return new Uint8Array(Module["wasmBinary"])
    }
    if (Module["readBinary"]) {
      return Module["readBinary"](wasmBinaryFile)
    } else {
      throw "both async and sync fetching of the wasm failed"
    }
  } catch (err) {
    abort(err)
  }
}

function getBinaryPromise() {
  if (!Module["wasmBinary"] && (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) && typeof fetch === "function") {
    return fetch(wasmBinaryFile, {
      credentials: "same-origin"
    }).then(function (response) {
      if (!response["ok"]) {
        throw "failed to load wasm binary file at '" + wasmBinaryFile + "'"
      }
      return response["arrayBuffer"]()
    }).catch(function () {
      return getBinary()
    })
  }
  return new Promise(function (resolve, reject) {
    resolve(getBinary())
  })
}

function createWasm(env) {
  var info = {
    "env": env,
    "global": {
      "NaN": NaN,
      Infinity: Infinity
    },
    "global.Math": Math,
    "asm2wasm": asm2wasmImports
  };

  function receiveInstance(instance, module) {
    var exports = instance.exports;
    Module["asm"] = exports;
    removeRunDependency("wasm-instantiate")
  }
  addRunDependency("wasm-instantiate");
  if (Module["instantiateWasm"]) {
    try {
      return Module["instantiateWasm"](info, receiveInstance)
    } catch (e) {
      err("Module.instantiateWasm callback failed with error: " + e);
      return false
    }
  }

  function receiveInstantiatedSource(output) {
    receiveInstance(output["instance"])
  }

  function instantiateArrayBuffer(receiver) {
    getBinaryPromise().then(function (binary) {
      return WebAssembly.instantiate(binary, info)
    }).then(receiver, function (reason) {
      err("failed to asynchronously prepare wasm: " + reason);
      abort(reason)
    })
  }
  if (!Module["wasmBinary"] && typeof WebAssembly.instantiateStreaming === "function" && !isDataURI(wasmBinaryFile) && typeof fetch === "function") {
    WebAssembly.instantiateStreaming(fetch(wasmBinaryFile, {
      credentials: "same-origin"
    }), info).then(receiveInstantiatedSource, function (reason) {
      err("wasm streaming compile failed: " + reason);
      err("falling back to ArrayBuffer instantiation");
      instantiateArrayBuffer(receiveInstantiatedSource)
    })
  } else {
    instantiateArrayBuffer(receiveInstantiatedSource)
  }
  return {}
}
Module["asm"] = function (global, env, providedBuffer) {
  env["memory"] = wasmMemory;
  env["table"] = wasmTable = new WebAssembly.Table({
    "initial": 846,
    "maximum": 846,
    "element": "anyfunc"
  });
  env["__memory_base"] = 1024;
  env["__table_base"] = 0;
  var exports = createWasm(env);
  return exports
};
var ASM_CONSTS = [function ($0, $1, $2, $3, $4, $5) {
  if (!artoolkit["frameMalloc"]) {
    artoolkit["frameMalloc"] = {}
  }
  var frameMalloc = artoolkit["frameMalloc"];
  frameMalloc["framepointer"] = $1;
  frameMalloc["framesize"] = $2;
  frameMalloc["camera"] = $3;
  frameMalloc["transform"] = $4;
  frameMalloc["videoLumaPointer"] = $5
}, function ($0, $1, $2, $3) {
  if (!artoolkit["multiEachMarkerInfo"]) {
    artoolkit["multiEachMarkerInfo"] = {}
  }
  var multiEachMarker = artoolkit["multiEachMarkerInfo"];
  multiEachMarker["visible"] = $0;
  multiEachMarker["pattId"] = $1;
  multiEachMarker["pattType"] = $2;
  multiEachMarker["width"] = $3
}, function ($0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32) {
  var $a = arguments;
  var i = 12;
  if (!artoolkit["markerInfo"]) {
    artoolkit["markerInfo"] = {
      pos: [0, 0],
      line: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0]
      ],
      vertex: [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0]
      ]
    }
  }
  var markerInfo = artoolkit["markerInfo"];
  markerInfo["area"] = $0;
  markerInfo["id"] = $1;
  markerInfo["idPatt"] = $2;
  markerInfo["idMatrix"] = $3;
  markerInfo["dir"] = $4;
  markerInfo["dirPatt"] = $5;
  markerInfo["dirMatrix"] = $6;
  markerInfo["cf"] = $7;
  markerInfo["cfPatt"] = $8;
  markerInfo["cfMatrix"] = $9;
  markerInfo["pos"][0] = $10;
  markerInfo["pos"][1] = $11;
  markerInfo["line"][0][0] = $a[i++];
  markerInfo["line"][0][1] = $a[i++];
  markerInfo["line"][0][2] = $a[i++];
  markerInfo["line"][1][0] = $a[i++];
  markerInfo["line"][1][1] = $a[i++];
  markerInfo["line"][1][2] = $a[i++];
  markerInfo["line"][2][0] = $a[i++];
  markerInfo["line"][2][1] = $a[i++];
  markerInfo["line"][2][2] = $a[i++];
  markerInfo["line"][3][0] = $a[i++];
  markerInfo["line"][3][1] = $a[i++];
  markerInfo["line"][3][2] = $a[i++];
  markerInfo["vertex"][0][0] = $a[i++];
  markerInfo["vertex"][0][1] = $a[i++];
  markerInfo["vertex"][1][0] = $a[i++];
  markerInfo["vertex"][1][1] = $a[i++];
  markerInfo["vertex"][2][0] = $a[i++];
  markerInfo["vertex"][2][1] = $a[i++];
  markerInfo["vertex"][3][0] = $a[i++];
  markerInfo["vertex"][3][1] = $a[i++];
  markerInfo["errorCorrected"] = $a[i++]
}, function ($0, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) {
  var $a = arguments;
  var i = 0;
  if (!artoolkit["NFTMarkerInfo"]) {
    artoolkit["NFTMarkerInfo"] = {
      id: 0,
      error: -1,
      found: 0,
      pose: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    }
  }
  var markerInfo = artoolkit["NFTMarkerInfo"];
  markerInfo["id"] = $a[i++];
  markerInfo["error"] = $a[i++];
  markerInfo["found"] = 1;
  markerInfo["pose"][0] = $a[i++];
  markerInfo["pose"][1] = $a[i++];
  markerInfo["pose"][2] = $a[i++];
  markerInfo["pose"][3] = $a[i++];
  markerInfo["pose"][4] = $a[i++];
  markerInfo["pose"][5] = $a[i++];
  markerInfo["pose"][6] = $a[i++];
  markerInfo["pose"][7] = $a[i++];
  markerInfo["pose"][8] = $a[i++];
  markerInfo["pose"][9] = $a[i++];
  markerInfo["pose"][10] = $a[i++];
  markerInfo["pose"][11] = $a[i++]
}, function ($0) {
  var $a = arguments;
  var i = 0;
  if (!artoolkit["NFTMarkerInfo"]) {
    artoolkit["NFTMarkerInfo"] = {
      id: 0,
      error: -1,
      found: 0,
      pose: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    }
  }
  var markerInfo = artoolkit["NFTMarkerInfo"];
  markerInfo["id"] = $a[i++];
  markerInfo["error"] = -1;
  markerInfo["found"] = 0;
  markerInfo["pose"][0] = 0;
  markerInfo["pose"][1] = 0;
  markerInfo["pose"][2] = 0;
  markerInfo["pose"][3] = 0;
  markerInfo["pose"][4] = 0;
  markerInfo["pose"][5] = 0;
  markerInfo["pose"][6] = 0;
  markerInfo["pose"][7] = 0;
  markerInfo["pose"][8] = 0;
  markerInfo["pose"][9] = 0;
  markerInfo["pose"][10] = 0;
  markerInfo["pose"][11] = 0
}];

function _emscripten_asm_const_iiiiiii(code, a0, a1, a2, a3, a4, a5) {
  return ASM_CONSTS[code](a0, a1, a2, a3, a4, a5)
}

function _emscripten_asm_const_iiiid(code, a0, a1, a2, a3) {
  return ASM_CONSTS[code](a0, a1, a2, a3)
}

function _emscripten_asm_const_iiddddddddddddd(code, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13) {
  return ASM_CONSTS[code](a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13)
}

function _emscripten_asm_const_ii(code, a0) {
  return ASM_CONSTS[code](a0)
}

function _emscripten_asm_const_iiiiiiiidddddddddddddddddddddddddi(code, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15, a16, a17, a18, a19, a20, a21, a22, a23, a24, a25, a26, a27, a28, a29, a30, a31, a32) {
  return ASM_CONSTS[code](a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15, a16, a17, a18, a19, a20, a21, a22, a23, a24, a25, a26, a27, a28, a29, a30, a31, a32)
}
__ATINIT__.push({
  func: function () {
    __GLOBAL__sub_I_ARToolKitJS_cpp()
  }
}, {
  func: function () {
    __GLOBAL__sub_I_bind_cpp()
  }
}, {
  func: function () {
    ___emscripten_environ_constructor()
  }
}, {
  func: function () {
    __GLOBAL__sub_I_iostream_cpp()
  }
});
var ENV = {};

function ___buildEnvironment(environ) {
  var MAX_ENV_VALUES = 64;
  var TOTAL_ENV_SIZE = 1024;
  var poolPtr;
  var envPtr;
  if (!___buildEnvironment.called) {
    ___buildEnvironment.called = true;
    ENV["USER"] = ENV["LOGNAME"] = "web_user";
    ENV["PATH"] = "/";
    ENV["PWD"] = "/";
    ENV["HOME"] = "/home/web_user";
    ENV["LANG"] = "C.UTF-8";
    ENV["_"] = Module["thisProgram"];
    poolPtr = getMemory(TOTAL_ENV_SIZE);
    envPtr = getMemory(MAX_ENV_VALUES * 4);
    HEAP32[envPtr >> 2] = poolPtr;
    HEAP32[environ >> 2] = envPtr
  } else {
    envPtr = HEAP32[environ >> 2];
    poolPtr = HEAP32[envPtr >> 2]
  }
  var strings = [];
  var totalSize = 0;
  for (var key in ENV) {
    if (typeof ENV[key] === "string") {
      var line = key + "=" + ENV[key];
      strings.push(line);
      totalSize += line.length
    }
  }
  if (totalSize > TOTAL_ENV_SIZE) {
    throw new Error("Environment size exceeded TOTAL_ENV_SIZE!")
  }
  var ptrSize = 4;
  for (var i = 0; i < strings.length; i++) {
    var line = strings[i];
    writeAsciiToMemory(line, poolPtr);
    HEAP32[envPtr + i * ptrSize >> 2] = poolPtr;
    poolPtr += line.length + 1
  }
  HEAP32[envPtr + strings.length * ptrSize >> 2] = 0
}

function _emscripten_get_now() {
  abort()
}

function _emscripten_get_now_is_monotonic() {
  return 0 || ENVIRONMENT_IS_NODE || typeof dateNow !== "undefined" || typeof performance === "object" && performance && typeof performance["now"] === "function"
}

function ___setErrNo(value) {
  if (Module["___errno_location"]) HEAP32[Module["___errno_location"]() >> 2] = value;
  return value
}

function _clock_gettime(clk_id, tp) {
  var now;
  if (clk_id === 0) {
    now = Date.now()
  } else if (clk_id === 1 && _emscripten_get_now_is_monotonic()) {
    now = _emscripten_get_now()
  } else {
    ___setErrNo(22);
    return -1
  }
  HEAP32[tp >> 2] = now / 1e3 | 0;
  HEAP32[tp + 4 >> 2] = now % 1e3 * 1e3 * 1e3 | 0;
  return 0
}

function ___clock_gettime(a0, a1) {
  return _clock_gettime(a0, a1)
}

function ___cxa_allocate_exception(size) {
  return _malloc(size)
}

function ___cxa_free_exception(ptr) {
  try {
    return _free(ptr)
  } catch (e) {}
}
var EXCEPTIONS = {
  last: 0,
  caught: [],
  infos: {},
  deAdjust: function (adjusted) {
    if (!adjusted || EXCEPTIONS.infos[adjusted]) return adjusted;
    for (var key in EXCEPTIONS.infos) {
      var ptr = +key;
      var adj = EXCEPTIONS.infos[ptr].adjusted;
      var len = adj.length;
      for (var i = 0; i < len; i++) {
        if (adj[i] === adjusted) {
          return ptr
        }
      }
    }
    return adjusted
  },
  addRef: function (ptr) {
    if (!ptr) return;
    var info = EXCEPTIONS.infos[ptr];
    info.refcount++
  },
  decRef: function (ptr) {
    if (!ptr) return;
    var info = EXCEPTIONS.infos[ptr];
    assert(info.refcount > 0);
    info.refcount--;
    if (info.refcount === 0 && !info.rethrown) {
      if (info.destructor) {
        Module["dynCall_vi"](info.destructor, ptr)
      }
      delete EXCEPTIONS.infos[ptr];
      ___cxa_free_exception(ptr)
    }
  },
  clearRef: function (ptr) {
    if (!ptr) return;
    var info = EXCEPTIONS.infos[ptr];
    info.refcount = 0
  }
};

function ___cxa_throw(ptr, type, destructor) {
  EXCEPTIONS.infos[ptr] = {
    ptr: ptr,
    adjusted: [ptr],
    type: type,
    destructor: destructor,
    refcount: 0,
    caught: false,
    rethrown: false
  };
  EXCEPTIONS.last = ptr;
  if (!("uncaught_exception" in __ZSt18uncaught_exceptionv)) {
    __ZSt18uncaught_exceptionv.uncaught_exception = 1
  } else {
    __ZSt18uncaught_exceptionv.uncaught_exception++
  }
  throw ptr
}

function ___cxa_uncaught_exception() {
  return !!__ZSt18uncaught_exceptionv.uncaught_exception
}

function ___lock() {}

function ___map_file(pathname, size) {
  ___setErrNo(1);
  return -1
}
var PATH = {
  splitPath: function (filename) {
    var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
    return splitPathRe.exec(filename).slice(1)
  },
  normalizeArray: function (parts, allowAboveRoot) {
    var up = 0;
    for (var i = parts.length - 1; i >= 0; i--) {
      var last = parts[i];
      if (last === ".") {
        parts.splice(i, 1)
      } else if (last === "..") {
        parts.splice(i, 1);
        up++
      } else if (up) {
        parts.splice(i, 1);
        up--
      }
    }
    if (allowAboveRoot) {
      for (; up; up--) {
        parts.unshift("..")
      }
    }
    return parts
  },
  normalize: function (path) {
    var isAbsolute = path.charAt(0) === "/",
      trailingSlash = path.substr(-1) === "/";
    path = PATH.normalizeArray(path.split("/").filter(function (p) {
      return !!p
    }), !isAbsolute).join("/");
    if (!path && !isAbsolute) {
      path = "."
    }
    if (path && trailingSlash) {
      path += "/"
    }
    return (isAbsolute ? "/" : "") + path
  },
  dirname: function (path) {
    var result = PATH.splitPath(path),
      root = result[0],
      dir = result[1];
    if (!root && !dir) {
      return "."
    }
    if (dir) {
      dir = dir.substr(0, dir.length - 1)
    }
    return root + dir
  },
  basename: function (path) {
    if (path === "/") return "/";
    var lastSlash = path.lastIndexOf("/");
    if (lastSlash === -1) return path;
    return path.substr(lastSlash + 1)
  },
  extname: function (path) {
    return PATH.splitPath(path)[3]
  },
  join: function () {
    var paths = Array.prototype.slice.call(arguments, 0);
    return PATH.normalize(paths.join("/"))
  },
  join2: function (l, r) {
    return PATH.normalize(l + "/" + r)
  },
  resolve: function () {
    var resolvedPath = "",
      resolvedAbsolute = false;
    for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
      var path = i >= 0 ? arguments[i] : FS.cwd();
      if (typeof path !== "string") {
        throw new TypeError("Arguments to path.resolve must be strings")
      } else if (!path) {
        return ""
      }
      resolvedPath = path + "/" + resolvedPath;
      resolvedAbsolute = path.charAt(0) === "/"
    }
    resolvedPath = PATH.normalizeArray(resolvedPath.split("/").filter(function (p) {
      return !!p
    }), !resolvedAbsolute).join("/");
    return (resolvedAbsolute ? "/" : "") + resolvedPath || "."
  },
  relative: function (from, to) {
    from = PATH.resolve(from).substr(1);
    to = PATH.resolve(to).substr(1);

    function trim(arr) {
      var start = 0;
      for (; start < arr.length; start++) {
        if (arr[start] !== "") break
      }
      var end = arr.length - 1;
      for (; end >= 0; end--) {
        if (arr[end] !== "") break
      }
      if (start > end) return [];
      return arr.slice(start, end - start + 1)
    }
    var fromParts = trim(from.split("/"));
    var toParts = trim(to.split("/"));
    var length = Math.min(fromParts.length, toParts.length);
    var samePartsLength = length;
    for (var i = 0; i < length; i++) {
      if (fromParts[i] !== toParts[i]) {
        samePartsLength = i;
        break
      }
    }
    var outputParts = [];
    for (var i = samePartsLength; i < fromParts.length; i++) {
      outputParts.push("..")
    }
    outputParts = outputParts.concat(toParts.slice(samePartsLength));
    return outputParts.join("/")
  }
};
var TTY = {
  ttys: [],
  init: function () {},
  shutdown: function () {},
  register: function (dev, ops) {
    TTY.ttys[dev] = {
      input: [],
      output: [],
      ops: ops
    };
    FS.registerDevice(dev, TTY.stream_ops)
  },
  stream_ops: {
    open: function (stream) {
      var tty = TTY.ttys[stream.node.rdev];
      if (!tty) {
        throw new FS.ErrnoError(19)
      }
      stream.tty = tty;
      stream.seekable = false
    },
    close: function (stream) {
      stream.tty.ops.flush(stream.tty)
    },
    flush: function (stream) {
      stream.tty.ops.flush(stream.tty)
    },
    read: function (stream, buffer, offset, length, pos) {
      if (!stream.tty || !stream.tty.ops.get_char) {
        throw new FS.ErrnoError(6)
      }
      var bytesRead = 0;
      for (var i = 0; i < length; i++) {
        var result;
        try {
          result = stream.tty.ops.get_char(stream.tty)
        } catch (e) {
          throw new FS.ErrnoError(5)
        }
        if (result === undefined && bytesRead === 0) {
          throw new FS.ErrnoError(11)
        }
        if (result === null || result === undefined) break;
        bytesRead++;
        buffer[offset + i] = result
      }
      if (bytesRead) {
        stream.node.timestamp = Date.now()
      }
      return bytesRead
    },
    write: function (stream, buffer, offset, length, pos) {
      if (!stream.tty || !stream.tty.ops.put_char) {
        throw new FS.ErrnoError(6)
      }
      try {
        for (var i = 0; i < length; i++) {
          stream.tty.ops.put_char(stream.tty, buffer[offset + i])
        }
      } catch (e) {
        throw new FS.ErrnoError(5)
      }
      if (length) {
        stream.node.timestamp = Date.now()
      }
      return i
    }
  },
  default_tty_ops: {
    get_char: function (tty) {
      if (!tty.input.length) {
        var result = null;
        if (ENVIRONMENT_IS_NODE) {
          var BUFSIZE = 256;
          var buf = new Buffer(BUFSIZE);
          var bytesRead = 0;
          var isPosixPlatform = process.platform != "win32";
          var fd = process.stdin.fd;
          if (isPosixPlatform) {
            var usingDevice = false;
            try {
              fd = fs.openSync("/dev/stdin", "r");
              usingDevice = true
            } catch (e) {}
          }
          try {
            bytesRead = fs.readSync(fd, buf, 0, BUFSIZE, null)
          } catch (e) {
            if (e.toString().indexOf("EOF") != -1) bytesRead = 0;
            else throw e
          }
          if (usingDevice) {
            fs.closeSync(fd)
          }
          if (bytesRead > 0) {
            result = buf.slice(0, bytesRead).toString("utf-8")
          } else {
            result = null
          }
        } else if (typeof window != "undefined" && typeof window.prompt == "function") {
          result = window.prompt("Input: ");
          if (result !== null) {
            result += "\n"
          }
        } else if (typeof readline == "function") {
          result = readline();
          if (result !== null) {
            result += "\n"
          }
        }
        if (!result) {
          return null
        }
        tty.input = intArrayFromString(result, true)
      }
      return tty.input.shift()
    },
    put_char: function (tty, val) {
      if (val === null || val === 10) {
        out(UTF8ArrayToString(tty.output, 0));
        tty.output = []
      } else {
        if (val != 0) tty.output.push(val)
      }
    },
    flush: function (tty) {
      if (tty.output && tty.output.length > 0) {
        out(UTF8ArrayToString(tty.output, 0));
        tty.output = []
      }
    }
  },
  default_tty1_ops: {
    put_char: function (tty, val) {
      if (val === null || val === 10) {
        err(UTF8ArrayToString(tty.output, 0));
        tty.output = []
      } else {
        if (val != 0) tty.output.push(val)
      }
    },
    flush: function (tty) {
      if (tty.output && tty.output.length > 0) {
        err(UTF8ArrayToString(tty.output, 0));
        tty.output = []
      }
    }
  }
};
var MEMFS = {
  ops_table: null,
  mount: function (mount) {
    return MEMFS.createNode(null, "/", 16384 | 511, 0)
  },
  createNode: function (parent, name, mode, dev) {
    if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
      throw new FS.ErrnoError(1)
    }
    if (!MEMFS.ops_table) {
      MEMFS.ops_table = {
        dir: {
          node: {
            getattr: MEMFS.node_ops.getattr,
            setattr: MEMFS.node_ops.setattr,
            lookup: MEMFS.node_ops.lookup,
            mknod: MEMFS.node_ops.mknod,
            rename: MEMFS.node_ops.rename,
            unlink: MEMFS.node_ops.unlink,
            rmdir: MEMFS.node_ops.rmdir,
            readdir: MEMFS.node_ops.readdir,
            symlink: MEMFS.node_ops.symlink
          },
          stream: {
            llseek: MEMFS.stream_ops.llseek
          }
        },
        file: {
          node: {
            getattr: MEMFS.node_ops.getattr,
            setattr: MEMFS.node_ops.setattr
          },
          stream: {
            llseek: MEMFS.stream_ops.llseek,
            read: MEMFS.stream_ops.read,
            write: MEMFS.stream_ops.write,
            allocate: MEMFS.stream_ops.allocate,
            mmap: MEMFS.stream_ops.mmap,
            msync: MEMFS.stream_ops.msync
          }
        },
        link: {
          node: {
            getattr: MEMFS.node_ops.getattr,
            setattr: MEMFS.node_ops.setattr,
            readlink: MEMFS.node_ops.readlink
          },
          stream: {}
        },
        chrdev: {
          node: {
            getattr: MEMFS.node_ops.getattr,
            setattr: MEMFS.node_ops.setattr
          },
          stream: FS.chrdev_stream_ops
        }
      }
    }
    var node = FS.createNode(parent, name, mode, dev);
    if (FS.isDir(node.mode)) {
      node.node_ops = MEMFS.ops_table.dir.node;
      node.stream_ops = MEMFS.ops_table.dir.stream;
      node.contents = {}
    } else if (FS.isFile(node.mode)) {
      node.node_ops = MEMFS.ops_table.file.node;
      node.stream_ops = MEMFS.ops_table.file.stream;
      node.usedBytes = 0;
      node.contents = null
    } else if (FS.isLink(node.mode)) {
      node.node_ops = MEMFS.ops_table.link.node;
      node.stream_ops = MEMFS.ops_table.link.stream
    } else if (FS.isChrdev(node.mode)) {
      node.node_ops = MEMFS.ops_table.chrdev.node;
      node.stream_ops = MEMFS.ops_table.chrdev.stream
    }
    node.timestamp = Date.now();
    if (parent) {
      parent.contents[name] = node
    }
    return node
  },
  getFileDataAsRegularArray: function (node) {
    if (node.contents && node.contents.subarray) {
      var arr = [];
      for (var i = 0; i < node.usedBytes; ++i) arr.push(node.contents[i]);
      return arr
    }
    return node.contents
  },
  getFileDataAsTypedArray: function (node) {
    if (!node.contents) return new Uint8Array;
    if (node.contents.subarray) return node.contents.subarray(0, node.usedBytes);
    return new Uint8Array(node.contents)
  },
  expandFileStorage: function (node, newCapacity) {
    var prevCapacity = node.contents ? node.contents.length : 0;
    if (prevCapacity >= newCapacity) return;
    var CAPACITY_DOUBLING_MAX = 1024 * 1024;
    newCapacity = Math.max(newCapacity, prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2 : 1.125) | 0);
    if (prevCapacity != 0) newCapacity = Math.max(newCapacity, 256);
    var oldContents = node.contents;
    node.contents = new Uint8Array(newCapacity);
    if (node.usedBytes > 0) node.contents.set(oldContents.subarray(0, node.usedBytes), 0);
    return
  },
  resizeFileStorage: function (node, newSize) {
    if (node.usedBytes == newSize) return;
    if (newSize == 0) {
      node.contents = null;
      node.usedBytes = 0;
      return
    }
    if (!node.contents || node.contents.subarray) {
      var oldContents = node.contents;
      node.contents = new Uint8Array(new ArrayBuffer(newSize));
      if (oldContents) {
        node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes)))
      }
      node.usedBytes = newSize;
      return
    }
    if (!node.contents) node.contents = [];
    if (node.contents.length > newSize) node.contents.length = newSize;
    else
      while (node.contents.length < newSize) node.contents.push(0);
    node.usedBytes = newSize
  },
  node_ops: {
    getattr: function (node) {
      var attr = {};
      attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
      attr.ino = node.id;
      attr.mode = node.mode;
      attr.nlink = 1;
      attr.uid = 0;
      attr.gid = 0;
      attr.rdev = node.rdev;
      if (FS.isDir(node.mode)) {
        attr.size = 4096
      } else if (FS.isFile(node.mode)) {
        attr.size = node.usedBytes
      } else if (FS.isLink(node.mode)) {
        attr.size = node.link.length
      } else {
        attr.size = 0
      }
      attr.atime = new Date(node.timestamp);
      attr.mtime = new Date(node.timestamp);
      attr.ctime = new Date(node.timestamp);
      attr.blksize = 4096;
      attr.blocks = Math.ceil(attr.size / attr.blksize);
      return attr
    },
    setattr: function (node, attr) {
      if (attr.mode !== undefined) {
        node.mode = attr.mode
      }
      if (attr.timestamp !== undefined) {
        node.timestamp = attr.timestamp
      }
      if (attr.size !== undefined) {
        MEMFS.resizeFileStorage(node, attr.size)
      }
    },
    lookup: function (parent, name) {
      throw FS.genericErrors[2]
    },
    mknod: function (parent, name, mode, dev) {
      return MEMFS.createNode(parent, name, mode, dev)
    },
    rename: function (old_node, new_dir, new_name) {
      if (FS.isDir(old_node.mode)) {
        var new_node;
        try {
          new_node = FS.lookupNode(new_dir, new_name)
        } catch (e) {}
        if (new_node) {
          for (var i in new_node.contents) {
            throw new FS.ErrnoError(39)
          }
        }
      }
      delete old_node.parent.contents[old_node.name];
      old_node.name = new_name;
      new_dir.contents[new_name] = old_node;
      old_node.parent = new_dir
    },
    unlink: function (parent, name) {
      delete parent.contents[name]
    },
    rmdir: function (parent, name) {
      var node = FS.lookupNode(parent, name);
      for (var i in node.contents) {
        throw new FS.ErrnoError(39)
      }
      delete parent.contents[name]
    },
    readdir: function (node) {
      var entries = [".", ".."];
      for (var key in node.contents) {
        if (!node.contents.hasOwnProperty(key)) {
          continue
        }
        entries.push(key)
      }
      return entries
    },
    symlink: function (parent, newname, oldpath) {
      var node = MEMFS.createNode(parent, newname, 511 | 40960, 0);
      node.link = oldpath;
      return node
    },
    readlink: function (node) {
      if (!FS.isLink(node.mode)) {
        throw new FS.ErrnoError(22)
      }
      return node.link
    }
  },
  stream_ops: {
    read: function (stream, buffer, offset, length, position) {
      var contents = stream.node.contents;
      if (position >= stream.node.usedBytes) return 0;
      var size = Math.min(stream.node.usedBytes - position, length);
      if (size > 8 && contents.subarray) {
        buffer.set(contents.subarray(position, position + size), offset)
      } else {
        for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i]
      }
      return size
    },
    write: function (stream, buffer, offset, length, position, canOwn) {
      if (!length) return 0;
      var node = stream.node;
      node.timestamp = Date.now();
      if (buffer.subarray && (!node.contents || node.contents.subarray)) {
        if (canOwn) {
          node.contents = buffer.subarray(offset, offset + length);
          node.usedBytes = length;
          return length
        } else if (node.usedBytes === 0 && position === 0) {
          node.contents = new Uint8Array(buffer.subarray(offset, offset + length));
          node.usedBytes = length;
          return length
        } else if (position + length <= node.usedBytes) {
          node.contents.set(buffer.subarray(offset, offset + length), position);
          return length
        }
      }
      MEMFS.expandFileStorage(node, position + length);
      if (node.contents.subarray && buffer.subarray) node.contents.set(buffer.subarray(offset, offset + length), position);
      else {
        for (var i = 0; i < length; i++) {
          node.contents[position + i] = buffer[offset + i]
        }
      }
      node.usedBytes = Math.max(node.usedBytes, position + length);
      return length
    },
    llseek: function (stream, offset, whence) {
      var position = offset;
      if (whence === 1) {
        position += stream.position
      } else if (whence === 2) {
        if (FS.isFile(stream.node.mode)) {
          position += stream.node.usedBytes
        }
      }
      if (position < 0) {
        throw new FS.ErrnoError(22)
      }
      return position
    },
    allocate: function (stream, offset, length) {
      MEMFS.expandFileStorage(stream.node, offset + length);
      stream.node.usedBytes = Math.max(stream.node.usedBytes, offset + length)
    },
    mmap: function (stream, buffer, offset, length, position, prot, flags) {
      if (!FS.isFile(stream.node.mode)) {
        throw new FS.ErrnoError(19)
      }
      var ptr;
      var allocated;
      var contents = stream.node.contents;
      if (!(flags & 2) && (contents.buffer === buffer || contents.buffer === buffer.buffer)) {
        allocated = false;
        ptr = contents.byteOffset
      } else {
        if (position > 0 || position + length < stream.node.usedBytes) {
          if (contents.subarray) {
            contents = contents.subarray(position, position + length)
          } else {
            contents = Array.prototype.slice.call(contents, position, position + length)
          }
        }
        allocated = true;
        ptr = _malloc(length);
        if (!ptr) {
          throw new FS.ErrnoError(12)
        }
        buffer.set(contents, ptr)
      }
      return {
        ptr: ptr,
        allocated: allocated
      }
    },
    msync: function (stream, buffer, offset, length, mmapFlags) {
      if (!FS.isFile(stream.node.mode)) {
        throw new FS.ErrnoError(19)
      }
      if (mmapFlags & 2) {
        return 0
      }
      var bytesWritten = MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false);
      return 0
    }
  }
};
var IDBFS = {
  dbs: {},
  indexedDB: function () {
    if (typeof indexedDB !== "undefined") return indexedDB;
    var ret = null;
    if (typeof window === "object") ret = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
    assert(ret, "IDBFS used, but indexedDB not supported");
    return ret
  },
  DB_VERSION: 21,
  DB_STORE_NAME: "FILE_DATA",
  mount: function (mount) {
    return MEMFS.mount.apply(null, arguments)
  },
  syncfs: function (mount, populate, callback) {
    IDBFS.getLocalSet(mount, function (err, local) {
      if (err) return callback(err);
      IDBFS.getRemoteSet(mount, function (err, remote) {
        if (err) return callback(err);
        var src = populate ? remote : local;
        var dst = populate ? local : remote;
        IDBFS.reconcile(src, dst, callback)
      })
    })
  },
  getDB: function (name, callback) {
    var db = IDBFS.dbs[name];
    if (db) {
      return callback(null, db)
    }
    var req;
    try {
      req = IDBFS.indexedDB().open(name, IDBFS.DB_VERSION)
    } catch (e) {
      return callback(e)
    }
    if (!req) {
      return callback("Unable to connect to IndexedDB")
    }
    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      var transaction = e.target.transaction;
      var fileStore;
      if (db.objectStoreNames.contains(IDBFS.DB_STORE_NAME)) {
        fileStore = transaction.objectStore(IDBFS.DB_STORE_NAME)
      } else {
        fileStore = db.createObjectStore(IDBFS.DB_STORE_NAME)
      }
      if (!fileStore.indexNames.contains("timestamp")) {
        fileStore.createIndex("timestamp", "timestamp", {
          unique: false
        })
      }
    };
    req.onsuccess = function () {
      db = req.result;
      IDBFS.dbs[name] = db;
      callback(null, db)
    };
    req.onerror = function (e) {
      callback(this.error);
      e.preventDefault()
    }
  },
  getLocalSet: function (mount, callback) {
    var entries = {};

    function isRealDir(p) {
      return p !== "." && p !== ".."
    }

    function toAbsolute(root) {
      return function (p) {
        return PATH.join2(root, p)
      }
    }
    var check = FS.readdir(mount.mountpoint).filter(isRealDir).map(toAbsolute(mount.mountpoint));
    while (check.length) {
      var path = check.pop();
      var stat;
      try {
        stat = FS.stat(path)
      } catch (e) {
        return callback(e)
      }
      if (FS.isDir(stat.mode)) {
        check.push.apply(check, FS.readdir(path).filter(isRealDir).map(toAbsolute(path)))
      }
      entries[path] = {
        timestamp: stat.mtime
      }
    }
    return callback(null, {
      type: "local",
      entries: entries
    })
  },
  getRemoteSet: function (mount, callback) {
    var entries = {};
    IDBFS.getDB(mount.mountpoint, function (err, db) {
      if (err) return callback(err);
      try {
        var transaction = db.transaction([IDBFS.DB_STORE_NAME], "readonly");
        transaction.onerror = function (e) {
          callback(this.error);
          e.preventDefault()
        };
        var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
        var index = store.index("timestamp");
        index.openKeyCursor().onsuccess = function (event) {
          var cursor = event.target.result;
          if (!cursor) {
            return callback(null, {
              type: "remote",
              db: db,
              entries: entries
            })
          }
          entries[cursor.primaryKey] = {
            timestamp: cursor.key
          };
          cursor.continue()
        }
      } catch (e) {
        return callback(e)
      }
    })
  },
  loadLocalEntry: function (path, callback) {
    var stat, node;
    try {
      var lookup = FS.lookupPath(path);
      node = lookup.node;
      stat = FS.stat(path)
    } catch (e) {
      return callback(e)
    }
    if (FS.isDir(stat.mode)) {
      return callback(null, {
        timestamp: stat.mtime,
        mode: stat.mode
      })
    } else if (FS.isFile(stat.mode)) {
      node.contents = MEMFS.getFileDataAsTypedArray(node);
      return callback(null, {
        timestamp: stat.mtime,
        mode: stat.mode,
        contents: node.contents
      })
    } else {
      return callback(new Error("node type not supported"))
    }
  },
  storeLocalEntry: function (path, entry, callback) {
    try {
      if (FS.isDir(entry.mode)) {
        FS.mkdir(path, entry.mode)
      } else if (FS.isFile(entry.mode)) {
        FS.writeFile(path, entry.contents, {
          canOwn: true
        })
      } else {
        return callback(new Error("node type not supported"))
      }
      FS.chmod(path, entry.mode);
      FS.utime(path, entry.timestamp, entry.timestamp)
    } catch (e) {
      return callback(e)
    }
    callback(null)
  },
  removeLocalEntry: function (path, callback) {
    try {
      var lookup = FS.lookupPath(path);
      var stat = FS.stat(path);
      if (FS.isDir(stat.mode)) {
        FS.rmdir(path)
      } else if (FS.isFile(stat.mode)) {
        FS.unlink(path)
      }
    } catch (e) {
      return callback(e)
    }
    callback(null)
  },
  loadRemoteEntry: function (store, path, callback) {
    var req = store.get(path);
    req.onsuccess = function (event) {
      callback(null, event.target.result)
    };
    req.onerror = function (e) {
      callback(this.error);
      e.preventDefault()
    }
  },
  storeRemoteEntry: function (store, path, entry, callback) {
    var req = store.put(entry, path);
    req.onsuccess = function () {
      callback(null)
    };
    req.onerror = function (e) {
      callback(this.error);
      e.preventDefault()
    }
  },
  removeRemoteEntry: function (store, path, callback) {
    var req = store.delete(path);
    req.onsuccess = function () {
      callback(null)
    };
    req.onerror = function (e) {
      callback(this.error);
      e.preventDefault()
    }
  },
  reconcile: function (src, dst, callback) {
    var total = 0;
    var create = [];
    Object.keys(src.entries).forEach(function (key) {
      var e = src.entries[key];
      var e2 = dst.entries[key];
      if (!e2 || e.timestamp > e2.timestamp) {
        create.push(key);
        total++
      }
    });
    var remove = [];
    Object.keys(dst.entries).forEach(function (key) {
      var e = dst.entries[key];
      var e2 = src.entries[key];
      if (!e2) {
        remove.push(key);
        total++
      }
    });
    if (!total) {
      return callback(null)
    }
    var errored = false;
    var completed = 0;
    var db = src.type === "remote" ? src.db : dst.db;
    var transaction = db.transaction([IDBFS.DB_STORE_NAME], "readwrite");
    var store = transaction.objectStore(IDBFS.DB_STORE_NAME);

    function done(err) {
      if (err) {
        if (!done.errored) {
          done.errored = true;
          return callback(err)
        }
        return
      }
      if (++completed >= total) {
        return callback(null)
      }
    }
    transaction.onerror = function (e) {
      done(this.error);
      e.preventDefault()
    };
    create.sort().forEach(function (path) {
      if (dst.type === "local") {
        IDBFS.loadRemoteEntry(store, path, function (err, entry) {
          if (err) return done(err);
          IDBFS.storeLocalEntry(path, entry, done)
        })
      } else {
        IDBFS.loadLocalEntry(path, function (err, entry) {
          if (err) return done(err);
          IDBFS.storeRemoteEntry(store, path, entry, done)
        })
      }
    });
    remove.sort().reverse().forEach(function (path) {
      if (dst.type === "local") {
        IDBFS.removeLocalEntry(path, done)
      } else {
        IDBFS.removeRemoteEntry(store, path, done)
      }
    })
  }
};
var NODEFS = {
  isWindows: false,
  staticInit: function () {
    NODEFS.isWindows = !!process.platform.match(/^win/);
    var flags = process["binding"]("constants");
    if (flags["fs"]) {
      flags = flags["fs"]
    }
    NODEFS.flagsForNodeMap = {
      1024: flags["O_APPEND"],
      64: flags["O_CREAT"],
      128: flags["O_EXCL"],
      0: flags["O_RDONLY"],
      2: flags["O_RDWR"],
      4096: flags["O_SYNC"],
      512: flags["O_TRUNC"],
      1: flags["O_WRONLY"]
    }
  },
  bufferFrom: function (arrayBuffer) {
    return Buffer.alloc ? Buffer.from(arrayBuffer) : new Buffer(arrayBuffer)
  },
  mount: function (mount) {
    assert(ENVIRONMENT_IS_NODE);
    return NODEFS.createNode(null, "/", NODEFS.getMode(mount.opts.root), 0)
  },
  createNode: function (parent, name, mode, dev) {
    if (!FS.isDir(mode) && !FS.isFile(mode) && !FS.isLink(mode)) {
      throw new FS.ErrnoError(22)
    }
    var node = FS.createNode(parent, name, mode);
    node.node_ops = NODEFS.node_ops;
    node.stream_ops = NODEFS.stream_ops;
    return node
  },
  getMode: function (path) {
    var stat;
    try {
      stat = fs.lstatSync(path);
      if (NODEFS.isWindows) {
        stat.mode = stat.mode | (stat.mode & 292) >> 2
      }
    } catch (e) {
      if (!e.code) throw e;
      throw new FS.ErrnoError(-e.errno)
    }
    return stat.mode
  },
  realPath: function (node) {
    var parts = [];
    while (node.parent !== node) {
      parts.push(node.name);
      node = node.parent
    }
    parts.push(node.mount.opts.root);
    parts.reverse();
    return PATH.join.apply(null, parts)
  },
  flagsForNode: function (flags) {
    flags &= ~2097152;
    flags &= ~2048;
    flags &= ~32768;
    flags &= ~524288;
    var newFlags = 0;
    for (var k in NODEFS.flagsForNodeMap) {
      if (flags & k) {
        newFlags |= NODEFS.flagsForNodeMap[k];
        flags ^= k
      }
    }
    if (!flags) {
      return newFlags
    } else {
      throw new FS.ErrnoError(22)
    }
  },
  node_ops: {
    getattr: function (node) {
      var path = NODEFS.realPath(node);
      var stat;
      try {
        stat = fs.lstatSync(path)
      } catch (e) {
        if (!e.code) throw e;
        throw new FS.ErrnoError(-e.errno)
      }
      if (NODEFS.isWindows && !stat.blksize) {
        stat.blksize = 4096
      }
      if (NODEFS.isWindows && !stat.blocks) {
        stat.blocks = (stat.size + stat.blksize - 1) / stat.blksize | 0
      }
      return {
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        nlink: stat.nlink,
        uid: stat.uid,
        gid: stat.gid,
        rdev: stat.rdev,
        size: stat.size,
        atime: stat.atime,
        mtime: stat.mtime,
        ctime: stat.ctime,
        blksize: stat.blksize,
        blocks: stat.blocks
      }
    },
    setattr: function (node, attr) {
      var path = NODEFS.realPath(node);
      try {
        if (attr.mode !== undefined) {
          fs.chmodSync(path, attr.mode);
          node.mode = attr.mode
        }
        if (attr.timestamp !== undefined) {
          var date = new Date(attr.timestamp);
          fs.utimesSync(path, date, date)
        }
        if (attr.size !== undefined) {
          fs.truncateSync(path, attr.size)
        }
      } catch (e) {
        if (!e.code) throw e;
        throw new FS.ErrnoError(-e.errno)
      }
    },
    lookup: function (parent, name) {
      var path = PATH.join2(NODEFS.realPath(parent), name);
      var mode = NODEFS.getMode(path);
      return NODEFS.createNode(parent, name, mode)
    },
    mknod: function (parent, name, mode, dev) {
      var node = NODEFS.createNode(parent, name, mode, dev);
      var path = NODEFS.realPath(node);
      try {
        if (FS.isDir(node.mode)) {
          fs.mkdirSync(path, node.mode)
        } else {
          fs.writeFileSync(path, "", {
            mode: node.mode
          })
        }
      } catch (e) {
        if (!e.code) throw e;
        throw new FS.ErrnoError(-e.errno)
      }
      return node
    },
    rename: function (oldNode, newDir, newName) {
      var oldPath = NODEFS.realPath(oldNode);
      var newPath = PATH.join2(NODEFS.realPath(newDir), newName);
      try {
        fs.renameSync(oldPath, newPath)
      } catch (e) {
        if (!e.code) throw e;
        throw new FS.ErrnoError(-e.errno)
      }
    },
    unlink: function (parent, name) {
      var path = PATH.join2(NODEFS.realPath(parent), name);
      try {
        fs.unlinkSync(path)
      } catch (e) {
        if (!e.code) throw e;
        throw new FS.ErrnoError(-e.errno)
      }
    },
    rmdir: function (parent, name) {
      var path = PATH.join2(NODEFS.realPath(parent), name);
      try {
        fs.rmdirSync(path)
      } catch (e) {
        if (!e.code) throw e;
        throw new FS.ErrnoError(-e.errno)
      }
    },
    readdir: function (node) {
      var path = NODEFS.realPath(node);
      try {
        return fs.readdirSync(path)
      } catch (e) {
        if (!e.code) throw e;
        throw new FS.ErrnoError(-e.errno)
      }
    },
    symlink: function (parent, newName, oldPath) {
      var newPath = PATH.join2(NODEFS.realPath(parent), newName);
      try {
        fs.symlinkSync(oldPath, newPath)
      } catch (e) {
        if (!e.code) throw e;
        throw new FS.ErrnoError(-e.errno)
      }
    },
    readlink: function (node) {
      var path = NODEFS.realPath(node);
      try {
        path = fs.readlinkSync(path);
        path = NODEJS_PATH.relative(NODEJS_PATH.resolve(node.mount.opts.root), path);
        return path
      } catch (e) {
        if (!e.code) throw e;
        throw new FS.ErrnoError(-e.errno)
      }
    }
  },
  stream_ops: {
    open: function (stream) {
      var path = NODEFS.realPath(stream.node);
      try {
        if (FS.isFile(stream.node.mode)) {
          stream.nfd = fs.openSync(path, NODEFS.flagsForNode(stream.flags))
        }
      } catch (e) {
        if (!e.code) throw e;
        throw new FS.ErrnoError(-e.errno)
      }
    },
    close: function (stream) {
      try {
        if (FS.isFile(stream.node.mode) && stream.nfd) {
          fs.closeSync(stream.nfd)
        }
      } catch (e) {
        if (!e.code) throw e;
        throw new FS.ErrnoError(-e.errno)
      }
    },
    read: function (stream, buffer, offset, length, position) {
      if (length === 0) return 0;
      try {
        return fs.readSync(stream.nfd, NODEFS.bufferFrom(buffer.buffer), offset, length, position)
      } catch (e) {
        throw new FS.ErrnoError(-e.errno)
      }
    },
    write: function (stream, buffer, offset, length, position) {
      try {
        return fs.writeSync(stream.nfd, NODEFS.bufferFrom(buffer.buffer), offset, length, position)
      } catch (e) {
        throw new FS.ErrnoError(-e.errno)
      }
    },
    llseek: function (stream, offset, whence) {
      var position = offset;
      if (whence === 1) {
        position += stream.position
      } else if (whence === 2) {
        if (FS.isFile(stream.node.mode)) {
          try {
            var stat = fs.fstatSync(stream.nfd);
            position += stat.size
          } catch (e) {
            throw new FS.ErrnoError(-e.errno)
          }
        }
      }
      if (position < 0) {
        throw new FS.ErrnoError(22)
      }
      return position
    }
  }
};
var WORKERFS = {
  DIR_MODE: 16895,
  FILE_MODE: 33279,
  reader: null,
  mount: function (mount) {
    assert(ENVIRONMENT_IS_WORKER);
    if (!WORKERFS.reader) WORKERFS.reader = new FileReaderSync;
    var root = WORKERFS.createNode(null, "/", WORKERFS.DIR_MODE, 0);
    var createdParents = {};

    function ensureParent(path) {
      var parts = path.split("/");
      var parent = root;
      for (var i = 0; i < parts.length - 1; i++) {
        var curr = parts.slice(0, i + 1).join("/");
        if (!createdParents[curr]) {
          createdParents[curr] = WORKERFS.createNode(parent, parts[i], WORKERFS.DIR_MODE, 0)
        }
        parent = createdParents[curr]
      }
      return parent
    }

    function base(path) {
      var parts = path.split("/");
      return parts[parts.length - 1]
    }
    Array.prototype.forEach.call(mount.opts["files"] || [], function (file) {
      WORKERFS.createNode(ensureParent(file.name), base(file.name), WORKERFS.FILE_MODE, 0, file, file.lastModifiedDate)
    });
    (mount.opts["blobs"] || []).forEach(function (obj) {
      WORKERFS.createNode(ensureParent(obj["name"]), base(obj["name"]), WORKERFS.FILE_MODE, 0, obj["data"])
    });
    (mount.opts["packages"] || []).forEach(function (pack) {
      pack["metadata"].files.forEach(function (file) {
        var name = file.filename.substr(1);
        WORKERFS.createNode(ensureParent(name), base(name), WORKERFS.FILE_MODE, 0, pack["blob"].slice(file.start, file.end))
      })
    });
    return root
  },
  createNode: function (parent, name, mode, dev, contents, mtime) {
    var node = FS.createNode(parent, name, mode);
    node.mode = mode;
    node.node_ops = WORKERFS.node_ops;
    node.stream_ops = WORKERFS.stream_ops;
    node.timestamp = (mtime || new Date).getTime();
    assert(WORKERFS.FILE_MODE !== WORKERFS.DIR_MODE);
    if (mode === WORKERFS.FILE_MODE) {
      node.size = contents.size;
      node.contents = contents
    } else {
      node.size = 4096;
      node.contents = {}
    }
    if (parent) {
      parent.contents[name] = node
    }
    return node
  },
  node_ops: {
    getattr: function (node) {
      return {
        dev: 1,
        ino: undefined,
        mode: node.mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: undefined,
        size: node.size,
        atime: new Date(node.timestamp),
        mtime: new Date(node.timestamp),
        ctime: new Date(node.timestamp),
        blksize: 4096,
        blocks: Math.ceil(node.size / 4096)
      }
    },
    setattr: function (node, attr) {
      if (attr.mode !== undefined) {
        node.mode = attr.mode
      }
      if (attr.timestamp !== undefined) {
        node.timestamp = attr.timestamp
      }
    },
    lookup: function (parent, name) {
      throw new FS.ErrnoError(2)
    },
    mknod: function (parent, name, mode, dev) {
      throw new FS.ErrnoError(1)
    },
    rename: function (oldNode, newDir, newName) {
      throw new FS.ErrnoError(1)
    },
    unlink: function (parent, name) {
      throw new FS.ErrnoError(1)
    },
    rmdir: function (parent, name) {
      throw new FS.ErrnoError(1)
    },
    readdir: function (node) {
      var entries = [".", ".."];
      for (var key in node.contents) {
        if (!node.contents.hasOwnProperty(key)) {
          continue
        }
        entries.push(key)
      }
      return entries
    },
    symlink: function (parent, newName, oldPath) {
      throw new FS.ErrnoError(1)
    },
    readlink: function (node) {
      throw new FS.ErrnoError(1)
    }
  },
  stream_ops: {
    read: function (stream, buffer, offset, length, position) {
      if (position >= stream.node.size) return 0;
      var chunk = stream.node.contents.slice(position, position + length);
      var ab = WORKERFS.reader.readAsArrayBuffer(chunk);
      buffer.set(new Uint8Array(ab), offset);
      return chunk.size
    },
    write: function (stream, buffer, offset, length, position) {
      throw new FS.ErrnoError(5)
    },
    llseek: function (stream, offset, whence) {
      var position = offset;
      if (whence === 1) {
        position += stream.position
      } else if (whence === 2) {
        if (FS.isFile(stream.node.mode)) {
          position += stream.node.size
        }
      }
      if (position < 0) {
        throw new FS.ErrnoError(22)
      }
      return position
    }
  }
};
var FS = {
  root: null,
  mounts: [],
  devices: {},
  streams: [],
  nextInode: 1,
  nameTable: null,
  currentPath: "/",
  initialized: false,
  ignorePermissions: true,
  trackingDelegate: {},
  tracking: {
    openFlags: {
      READ: 1,
      WRITE: 2
    }
  },
  ErrnoError: null,
  genericErrors: {},
  filesystems: null,
  syncFSRequests: 0,
  handleFSError: function (e) {
    if (!(e instanceof FS.ErrnoError)) throw e + " : " + stackTrace();
    return ___setErrNo(e.errno)
  },
  lookupPath: function (path, opts) {
    path = PATH.resolve(FS.cwd(), path);
    opts = opts || {};
    if (!path) return {
      path: "",
      node: null
    };
    var defaults = {
      follow_mount: true,
      recurse_count: 0
    };
    for (var key in defaults) {
      if (opts[key] === undefined) {
        opts[key] = defaults[key]
      }
    }
    if (opts.recurse_count > 8) {
      throw new FS.ErrnoError(40)
    }
    var parts = PATH.normalizeArray(path.split("/").filter(function (p) {
      return !!p
    }), false);
    var current = FS.root;
    var current_path = "/";
    for (var i = 0; i < parts.length; i++) {
      var islast = i === parts.length - 1;
      if (islast && opts.parent) {
        break
      }
      current = FS.lookupNode(current, parts[i]);
      current_path = PATH.join2(current_path, parts[i]);
      if (FS.isMountpoint(current)) {
        if (!islast || islast && opts.follow_mount) {
          current = current.mounted.root
        }
      }
      if (!islast || opts.follow) {
        var count = 0;
        while (FS.isLink(current.mode)) {
          var link = FS.readlink(current_path);
          current_path = PATH.resolve(PATH.dirname(current_path), link);
          var lookup = FS.lookupPath(current_path, {
            recurse_count: opts.recurse_count
          });
          current = lookup.node;
          if (count++ > 40) {
            throw new FS.ErrnoError(40)
          }
        }
      }
    }
    return {
      path: current_path,
      node: current
    }
  },
  getPath: function (node) {
    var path;
    while (true) {
      if (FS.isRoot(node)) {
        var mount = node.mount.mountpoint;
        if (!path) return mount;
        return mount[mount.length - 1] !== "/" ? mount + "/" + path : mount + path
      }
      path = path ? node.name + "/" + path : node.name;
      node = node.parent
    }
  },
  hashName: function (parentid, name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) {
      hash = (hash << 5) - hash + name.charCodeAt(i) | 0
    }
    return (parentid + hash >>> 0) % FS.nameTable.length
  },
  hashAddNode: function (node) {
    var hash = FS.hashName(node.parent.id, node.name);
    node.name_next = FS.nameTable[hash];
    FS.nameTable[hash] = node
  },
  hashRemoveNode: function (node) {
    var hash = FS.hashName(node.parent.id, node.name);
    if (FS.nameTable[hash] === node) {
      FS.nameTable[hash] = node.name_next
    } else {
      var current = FS.nameTable[hash];
      while (current) {
        if (current.name_next === node) {
          current.name_next = node.name_next;
          break
        }
        current = current.name_next
      }
    }
  },
  lookupNode: function (parent, name) {
    var err = FS.mayLookup(parent);
    if (err) {
      throw new FS.ErrnoError(err, parent)
    }
    var hash = FS.hashName(parent.id, name);
    for (var node = FS.nameTable[hash]; node; node = node.name_next) {
      var nodeName = node.name;
      if (node.parent.id === parent.id && nodeName === name) {
        return node
      }
    }
    return FS.lookup(parent, name)
  },
  createNode: function (parent, name, mode, rdev) {
    if (!FS.FSNode) {
      FS.FSNode = function (parent, name, mode, rdev) {
        if (!parent) {
          parent = this
        }
        this.parent = parent;
        this.mount = parent.mount;
        this.mounted = null;
        this.id = FS.nextInode++;
        this.name = name;
        this.mode = mode;
        this.node_ops = {};
        this.stream_ops = {};
        this.rdev = rdev
      };
      FS.FSNode.prototype = {};
      var readMode = 292 | 73;
      var writeMode = 146;
      Object.defineProperties(FS.FSNode.prototype, {
        read: {
          get: function () {
            return (this.mode & readMode) === readMode
          },
          set: function (val) {
            val ? this.mode |= readMode : this.mode &= ~readMode
          }
        },
        write: {
          get: function () {
            return (this.mode & writeMode) === writeMode
          },
          set: function (val) {
            val ? this.mode |= writeMode : this.mode &= ~writeMode
          }
        },
        isFolder: {
          get: function () {
            return FS.isDir(this.mode)
          }
        },
        isDevice: {
          get: function () {
            return FS.isChrdev(this.mode)
          }
        }
      })
    }
    var node = new FS.FSNode(parent, name, mode, rdev);
    FS.hashAddNode(node);
    return node
  },
  destroyNode: function (node) {
    FS.hashRemoveNode(node)
  },
  isRoot: function (node) {
    return node === node.parent
  },
  isMountpoint: function (node) {
    return !!node.mounted
  },
  isFile: function (mode) {
    return (mode & 61440) === 32768
  },
  isDir: function (mode) {
    return (mode & 61440) === 16384
  },
  isLink: function (mode) {
    return (mode & 61440) === 40960
  },
  isChrdev: function (mode) {
    return (mode & 61440) === 8192
  },
  isBlkdev: function (mode) {
    return (mode & 61440) === 24576
  },
  isFIFO: function (mode) {
    return (mode & 61440) === 4096
  },
  isSocket: function (mode) {
    return (mode & 49152) === 49152
  },
  flagModes: {
    "r": 0,
    "rs": 1052672,
    "r+": 2,
    "w": 577,
    "wx": 705,
    "xw": 705,
    "w+": 578,
    "wx+": 706,
    "xw+": 706,
    "a": 1089,
    "ax": 1217,
    "xa": 1217,
    "a+": 1090,
    "ax+": 1218,
    "xa+": 1218
  },
  modeStringToFlags: function (str) {
    var flags = FS.flagModes[str];
    if (typeof flags === "undefined") {
      throw new Error("Unknown file open mode: " + str)
    }
    return flags
  },
  flagsToPermissionString: function (flag) {
    var perms = ["r", "w", "rw"][flag & 3];
    if (flag & 512) {
      perms += "w"
    }
    return perms
  },
  nodePermissions: function (node, perms) {
    if (FS.ignorePermissions) {
      return 0
    }
    if (perms.indexOf("r") !== -1 && !(node.mode & 292)) {
      return 13
    } else if (perms.indexOf("w") !== -1 && !(node.mode & 146)) {
      return 13
    } else if (perms.indexOf("x") !== -1 && !(node.mode & 73)) {
      return 13
    }
    return 0
  },
  mayLookup: function (dir) {
    var err = FS.nodePermissions(dir, "x");
    if (err) return err;
    if (!dir.node_ops.lookup) return 13;
    return 0
  },
  mayCreate: function (dir, name) {
    try {
      var node = FS.lookupNode(dir, name);
      return 17
    } catch (e) {}
    return FS.nodePermissions(dir, "wx")
  },
  mayDelete: function (dir, name, isdir) {
    var node;
    try {
      node = FS.lookupNode(dir, name)
    } catch (e) {
      return e.errno
    }
    var err = FS.nodePermissions(dir, "wx");
    if (err) {
      return err
    }
    if (isdir) {
      if (!FS.isDir(node.mode)) {
        return 20
      }
      if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
        return 16
      }
    } else {
      if (FS.isDir(node.mode)) {
        return 21
      }
    }
    return 0
  },
  mayOpen: function (node, flags) {
    if (!node) {
      return 2
    }
    if (FS.isLink(node.mode)) {
      return 40
    } else if (FS.isDir(node.mode)) {
      if (FS.flagsToPermissionString(flags) !== "r" || flags & 512) {
        return 21
      }
    }
    return FS.nodePermissions(node, FS.flagsToPermissionString(flags))
  },
  MAX_OPEN_FDS: 4096,
  nextfd: function (fd_start, fd_end) {
    fd_start = fd_start || 0;
    fd_end = fd_end || FS.MAX_OPEN_FDS;
    for (var fd = fd_start; fd <= fd_end; fd++) {
      if (!FS.streams[fd]) {
        return fd
      }
    }
    throw new FS.ErrnoError(24)
  },
  getStream: function (fd) {
    return FS.streams[fd]
  },
  createStream: function (stream, fd_start, fd_end) {
    if (!FS.FSStream) {
      FS.FSStream = function () {};
      FS.FSStream.prototype = {};
      Object.defineProperties(FS.FSStream.prototype, {
        object: {
          get: function () {
            return this.node
          },
          set: function (val) {
            this.node = val
          }
        },
        isRead: {
          get: function () {
            return (this.flags & 2097155) !== 1
          }
        },
        isWrite: {
          get: function () {
            return (this.flags & 2097155) !== 0
          }
        },
        isAppend: {
          get: function () {
            return this.flags & 1024
          }
        }
      })
    }
    var newStream = new FS.FSStream;
    for (var p in stream) {
      newStream[p] = stream[p]
    }
    stream = newStream;
    var fd = FS.nextfd(fd_start, fd_end);
    stream.fd = fd;
    FS.streams[fd] = stream;
    return stream
  },
  closeStream: function (fd) {
    FS.streams[fd] = null
  },
  chrdev_stream_ops: {
    open: function (stream) {
      var device = FS.getDevice(stream.node.rdev);
      stream.stream_ops = device.stream_ops;
      if (stream.stream_ops.open) {
        stream.stream_ops.open(stream)
      }
    },
    llseek: function () {
      throw new FS.ErrnoError(29)
    }
  },
  major: function (dev) {
    return dev >> 8
  },
  minor: function (dev) {
    return dev & 255
  },
  makedev: function (ma, mi) {
    return ma << 8 | mi
  },
  registerDevice: function (dev, ops) {
    FS.devices[dev] = {
      stream_ops: ops
    }
  },
  getDevice: function (dev) {
    return FS.devices[dev]
  },
  getMounts: function (mount) {
    var mounts = [];
    var check = [mount];
    while (check.length) {
      var m = check.pop();
      mounts.push(m);
      check.push.apply(check, m.mounts)
    }
    return mounts
  },
  syncfs: function (populate, callback) {
    if (typeof populate === "function") {
      callback = populate;
      populate = false
    }
    FS.syncFSRequests++;
    if (FS.syncFSRequests > 1) {
      console.log("warning: " + FS.syncFSRequests + " FS.syncfs operations in flight at once, probably just doing extra work")
    }
    var mounts = FS.getMounts(FS.root.mount);
    var completed = 0;

    function doCallback(err) {
      FS.syncFSRequests--;
      return callback(err)
    }

    function done(err) {
      if (err) {
        if (!done.errored) {
          done.errored = true;
          return doCallback(err)
        }
        return
      }
      if (++completed >= mounts.length) {
        doCallback(null)
      }
    }
    mounts.forEach(function (mount) {
      if (!mount.type.syncfs) {
        return done(null)
      }
      mount.type.syncfs(mount, populate, done)
    })
  },
  mount: function (type, opts, mountpoint) {
    var root = mountpoint === "/";
    var pseudo = !mountpoint;
    var node;
    if (root && FS.root) {
      throw new FS.ErrnoError(16)
    } else if (!root && !pseudo) {
      var lookup = FS.lookupPath(mountpoint, {
        follow_mount: false
      });
      mountpoint = lookup.path;
      node = lookup.node;
      if (FS.isMountpoint(node)) {
        throw new FS.ErrnoError(16)
      }
      if (!FS.isDir(node.mode)) {
        throw new FS.ErrnoError(20)
      }
    }
    var mount = {
      type: type,
      opts: opts,
      mountpoint: mountpoint,
      mounts: []
    };
    var mountRoot = type.mount(mount);
    mountRoot.mount = mount;
    mount.root = mountRoot;
    if (root) {
      FS.root = mountRoot
    } else if (node) {
      node.mounted = mount;
      if (node.mount) {
        node.mount.mounts.push(mount)
      }
    }
    return mountRoot
  },
  unmount: function (mountpoint) {
    var lookup = FS.lookupPath(mountpoint, {
      follow_mount: false
    });
    if (!FS.isMountpoint(lookup.node)) {
      throw new FS.ErrnoError(22)
    }
    var node = lookup.node;
    var mount = node.mounted;
    var mounts = FS.getMounts(mount);
    Object.keys(FS.nameTable).forEach(function (hash) {
      var current = FS.nameTable[hash];
      while (current) {
        var next = current.name_next;
        if (mounts.indexOf(current.mount) !== -1) {
          FS.destroyNode(current)
        }
        current = next
      }
    });
    node.mounted = null;
    var idx = node.mount.mounts.indexOf(mount);
    node.mount.mounts.splice(idx, 1)
  },
  lookup: function (parent, name) {
    return parent.node_ops.lookup(parent, name)
  },
  mknod: function (path, mode, dev) {
    var lookup = FS.lookupPath(path, {
      parent: true
    });
    var parent = lookup.node;
    var name = PATH.basename(path);
    if (!name || name === "." || name === "..") {
      throw new FS.ErrnoError(22)
    }
    var err = FS.mayCreate(parent, name);
    if (err) {
      throw new FS.ErrnoError(err)
    }
    if (!parent.node_ops.mknod) {
      throw new FS.ErrnoError(1)
    }
    return parent.node_ops.mknod(parent, name, mode, dev)
  },
  create: function (path, mode) {
    mode = mode !== undefined ? mode : 438;
    mode &= 4095;
    mode |= 32768;
    return FS.mknod(path, mode, 0)
  },
  mkdir: function (path, mode) {
    mode = mode !== undefined ? mode : 511;
    mode &= 511 | 512;
    mode |= 16384;
    return FS.mknod(path, mode, 0)
  },
  mkdirTree: function (path, mode) {
    var dirs = path.split("/");
    var d = "";
    for (var i = 0; i < dirs.length; ++i) {
      if (!dirs[i]) continue;
      d += "/" + dirs[i];
      try {
        FS.mkdir(d, mode)
      } catch (e) {
        if (e.errno != 17) throw e
      }
    }
  },
  mkdev: function (path, mode, dev) {
    if (typeof dev === "undefined") {
      dev = mode;
      mode = 438
    }
    mode |= 8192;
    return FS.mknod(path, mode, dev)
  },
  symlink: function (oldpath, newpath) {
    if (!PATH.resolve(oldpath)) {
      throw new FS.ErrnoError(2)
    }
    var lookup = FS.lookupPath(newpath, {
      parent: true
    });
    var parent = lookup.node;
    if (!parent) {
      throw new FS.ErrnoError(2)
    }
    var newname = PATH.basename(newpath);
    var err = FS.mayCreate(parent, newname);
    if (err) {
      throw new FS.ErrnoError(err)
    }
    if (!parent.node_ops.symlink) {
      throw new FS.ErrnoError(1)
    }
    return parent.node_ops.symlink(parent, newname, oldpath)
  },
  rename: function (old_path, new_path) {
    var old_dirname = PATH.dirname(old_path);
    var new_dirname = PATH.dirname(new_path);
    var old_name = PATH.basename(old_path);
    var new_name = PATH.basename(new_path);
    var lookup, old_dir, new_dir;
    try {
      lookup = FS.lookupPath(old_path, {
        parent: true
      });
      old_dir = lookup.node;
      lookup = FS.lookupPath(new_path, {
        parent: true
      });
      new_dir = lookup.node
    } catch (e) {
      throw new FS.ErrnoError(16)
    }
    if (!old_dir || !new_dir) throw new FS.ErrnoError(2);
    if (old_dir.mount !== new_dir.mount) {
      throw new FS.ErrnoError(18)
    }
    var old_node = FS.lookupNode(old_dir, old_name);
    var relative = PATH.relative(old_path, new_dirname);
    if (relative.charAt(0) !== ".") {
      throw new FS.ErrnoError(22)
    }
    relative = PATH.relative(new_path, old_dirname);
    if (relative.charAt(0) !== ".") {
      throw new FS.ErrnoError(39)
    }
    var new_node;
    try {
      new_node = FS.lookupNode(new_dir, new_name)
    } catch (e) {}
    if (old_node === new_node) {
      return
    }
    var isdir = FS.isDir(old_node.mode);
    var err = FS.mayDelete(old_dir, old_name, isdir);
    if (err) {
      throw new FS.ErrnoError(err)
    }
    err = new_node ? FS.mayDelete(new_dir, new_name, isdir) : FS.mayCreate(new_dir, new_name);
    if (err) {
      throw new FS.ErrnoError(err)
    }
    if (!old_dir.node_ops.rename) {
      throw new FS.ErrnoError(1)
    }
    if (FS.isMountpoint(old_node) || new_node && FS.isMountpoint(new_node)) {
      throw new FS.ErrnoError(16)
    }
    if (new_dir !== old_dir) {
      err = FS.nodePermissions(old_dir, "w");
      if (err) {
        throw new FS.ErrnoError(err)
      }
    }
    try {
      if (FS.trackingDelegate["willMovePath"]) {
        FS.trackingDelegate["willMovePath"](old_path, new_path)
      }
    } catch (e) {
      console.log("FS.trackingDelegate['willMovePath']('" + old_path + "', '" + new_path + "') threw an exception: " + e.message)
    }
    FS.hashRemoveNode(old_node);
    try {
      old_dir.node_ops.rename(old_node, new_dir, new_name)
    } catch (e) {
      throw e
    } finally {
      FS.hashAddNode(old_node)
    }
    try {
      if (FS.trackingDelegate["onMovePath"]) FS.trackingDelegate["onMovePath"](old_path, new_path)
    } catch (e) {
      console.log("FS.trackingDelegate['onMovePath']('" + old_path + "', '" + new_path + "') threw an exception: " + e.message)
    }
  },
  rmdir: function (path) {
    var lookup = FS.lookupPath(path, {
      parent: true
    });
    var parent = lookup.node;
    var name = PATH.basename(path);
    var node = FS.lookupNode(parent, name);
    var err = FS.mayDelete(parent, name, true);
    if (err) {
      throw new FS.ErrnoError(err)
    }
    if (!parent.node_ops.rmdir) {
      throw new FS.ErrnoError(1)
    }
    if (FS.isMountpoint(node)) {
      throw new FS.ErrnoError(16)
    }
    try {
      if (FS.trackingDelegate["willDeletePath"]) {
        FS.trackingDelegate["willDeletePath"](path)
      }
    } catch (e) {
      console.log("FS.trackingDelegate['willDeletePath']('" + path + "') threw an exception: " + e.message)
    }
    parent.node_ops.rmdir(parent, name);
    FS.destroyNode(node);
    try {
      if (FS.trackingDelegate["onDeletePath"]) FS.trackingDelegate["onDeletePath"](path)
    } catch (e) {
      console.log("FS.trackingDelegate['onDeletePath']('" + path + "') threw an exception: " + e.message)
    }
  },
  readdir: function (path) {
    var lookup = FS.lookupPath(path, {
      follow: true
    });
    var node = lookup.node;
    if (!node.node_ops.readdir) {
      throw new FS.ErrnoError(20)
    }
    return node.node_ops.readdir(node)
  },
  unlink: function (path) {
    var lookup = FS.lookupPath(path, {
      parent: true
    });
    var parent = lookup.node;
    var name = PATH.basename(path);
    var node = FS.lookupNode(parent, name);
    var err = FS.mayDelete(parent, name, false);
    if (err) {
      throw new FS.ErrnoError(err)
    }
    if (!parent.node_ops.unlink) {
      throw new FS.ErrnoError(1)
    }
    if (FS.isMountpoint(node)) {
      throw new FS.ErrnoError(16)
    }
    try {
      if (FS.trackingDelegate["willDeletePath"]) {
        FS.trackingDelegate["willDeletePath"](path)
      }
    } catch (e) {
      console.log("FS.trackingDelegate['willDeletePath']('" + path + "') threw an exception: " + e.message)
    }
    parent.node_ops.unlink(parent, name);
    FS.destroyNode(node);
    try {
      if (FS.trackingDelegate["onDeletePath"]) FS.trackingDelegate["onDeletePath"](path)
    } catch (e) {
      console.log("FS.trackingDelegate['onDeletePath']('" + path + "') threw an exception: " + e.message)
    }
  },
  readlink: function (path) {
    var lookup = FS.lookupPath(path);
    var link = lookup.node;
    if (!link) {
      throw new FS.ErrnoError(2)
    }
    if (!link.node_ops.readlink) {
      throw new FS.ErrnoError(22)
    }
    return PATH.resolve(FS.getPath(link.parent), link.node_ops.readlink(link))
  },
  stat: function (path, dontFollow) {
    var lookup = FS.lookupPath(path, {
      follow: !dontFollow
    });
    var node = lookup.node;
    if (!node) {
      throw new FS.ErrnoError(2)
    }
    if (!node.node_ops.getattr) {
      throw new FS.ErrnoError(1)
    }
    return node.node_ops.getattr(node)
  },
  lstat: function (path) {
    return FS.stat(path, true)
  },
  chmod: function (path, mode, dontFollow) {
    var node;
    if (typeof path === "string") {
      var lookup = FS.lookupPath(path, {
        follow: !dontFollow
      });
      node = lookup.node
    } else {
      node = path
    }
    if (!node.node_ops.setattr) {
      throw new FS.ErrnoError(1)
    }
    node.node_ops.setattr(node, {
      mode: mode & 4095 | node.mode & ~4095,
      timestamp: Date.now()
    })
  },
  lchmod: function (path, mode) {
    FS.chmod(path, mode, true)
  },
  fchmod: function (fd, mode) {
    var stream = FS.getStream(fd);
    if (!stream) {
      throw new FS.ErrnoError(9)
    }
    FS.chmod(stream.node, mode)
  },
  chown: function (path, uid, gid, dontFollow) {
    var node;
    if (typeof path === "string") {
      var lookup = FS.lookupPath(path, {
        follow: !dontFollow
      });
      node = lookup.node
    } else {
      node = path
    }
    if (!node.node_ops.setattr) {
      throw new FS.ErrnoError(1)
    }
    node.node_ops.setattr(node, {
      timestamp: Date.now()
    })
  },
  lchown: function (path, uid, gid) {
    FS.chown(path, uid, gid, true)
  },
  fchown: function (fd, uid, gid) {
    var stream = FS.getStream(fd);
    if (!stream) {
      throw new FS.ErrnoError(9)
    }
    FS.chown(stream.node, uid, gid)
  },
  truncate: function (path, len) {
    if (len < 0) {
      throw new FS.ErrnoError(22)
    }
    var node;
    if (typeof path === "string") {
      var lookup = FS.lookupPath(path, {
        follow: true
      });
      node = lookup.node
    } else {
      node = path
    }
    if (!node.node_ops.setattr) {
      throw new FS.ErrnoError(1)
    }
    if (FS.isDir(node.mode)) {
      throw new FS.ErrnoError(21)
    }
    if (!FS.isFile(node.mode)) {
      throw new FS.ErrnoError(22)
    }
    var err = FS.nodePermissions(node, "w");
    if (err) {
      throw new FS.ErrnoError(err)
    }
    node.node_ops.setattr(node, {
      size: len,
      timestamp: Date.now()
    })
  },
  ftruncate: function (fd, len) {
    var stream = FS.getStream(fd);
    if (!stream) {
      throw new FS.ErrnoError(9)
    }
    if ((stream.flags & 2097155) === 0) {
      throw new FS.ErrnoError(22)
    }
    FS.truncate(stream.node, len)
  },
  utime: function (path, atime, mtime) {
    var lookup = FS.lookupPath(path, {
      follow: true
    });
    var node = lookup.node;
    node.node_ops.setattr(node, {
      timestamp: Math.max(atime, mtime)
    })
  },
  open: function (path, flags, mode, fd_start, fd_end) {
    if (path === "") {
      throw new FS.ErrnoError(2)
    }
    flags = typeof flags === "string" ? FS.modeStringToFlags(flags) : flags;
    mode = typeof mode === "undefined" ? 438 : mode;
    if (flags & 64) {
      mode = mode & 4095 | 32768
    } else {
      mode = 0
    }
    var node;
    if (typeof path === "object") {
      node = path
    } else {
      path = PATH.normalize(path);
      try {
        var lookup = FS.lookupPath(path, {
          follow: !(flags & 131072)
        });
        node = lookup.node
      } catch (e) {}
    }
    var created = false;
    if (flags & 64) {
      if (node) {
        if (flags & 128) {
          throw new FS.ErrnoError(17)
        }
      } else {
        node = FS.mknod(path, mode, 0);
        created = true
      }
    }
    if (!node) {
      throw new FS.ErrnoError(2)
    }
    if (FS.isChrdev(node.mode)) {
      flags &= ~512
    }
    if (flags & 65536 && !FS.isDir(node.mode)) {
      throw new FS.ErrnoError(20)
    }
    if (!created) {
      var err = FS.mayOpen(node, flags);
      if (err) {
        throw new FS.ErrnoError(err)
      }
    }
    if (flags & 512) {
      FS.truncate(node, 0)
    }
    flags &= ~(128 | 512);
    var stream = FS.createStream({
      node: node,
      path: FS.getPath(node),
      flags: flags,
      seekable: true,
      position: 0,
      stream_ops: node.stream_ops,
      ungotten: [],
      error: false
    }, fd_start, fd_end);
    if (stream.stream_ops.open) {
      stream.stream_ops.open(stream)
    }
    if (Module["logReadFiles"] && !(flags & 1)) {
      if (!FS.readFiles) FS.readFiles = {};
      if (!(path in FS.readFiles)) {
        FS.readFiles[path] = 1;
        console.log("FS.trackingDelegate error on read file: " + path)
      }
    }
    try {
      if (FS.trackingDelegate["onOpenFile"]) {
        var trackingFlags = 0;
        if ((flags & 2097155) !== 1) {
          trackingFlags |= FS.tracking.openFlags.READ
        }
        if ((flags & 2097155) !== 0) {
          trackingFlags |= FS.tracking.openFlags.WRITE
        }
        FS.trackingDelegate["onOpenFile"](path, trackingFlags)
      }
    } catch (e) {
      console.log("FS.trackingDelegate['onOpenFile']('" + path + "', flags) threw an exception: " + e.message)
    }
    return stream
  },
  close: function (stream) {
    if (FS.isClosed(stream)) {
      throw new FS.ErrnoError(9)
    }
    if (stream.getdents) stream.getdents = null;
    try {
      if (stream.stream_ops.close) {
        stream.stream_ops.close(stream)
      }
    } catch (e) {
      throw e
    } finally {
      FS.closeStream(stream.fd)
    }
    stream.fd = null
  },
  isClosed: function (stream) {
    return stream.fd === null
  },
  llseek: function (stream, offset, whence) {
    if (FS.isClosed(stream)) {
      throw new FS.ErrnoError(9)
    }
    if (!stream.seekable || !stream.stream_ops.llseek) {
      throw new FS.ErrnoError(29)
    }
    if (whence != 0 && whence != 1 && whence != 2) {
      throw new FS.ErrnoError(22)
    }
    stream.position = stream.stream_ops.llseek(stream, offset, whence);
    stream.ungotten = [];
    return stream.position
  },
  read: function (stream, buffer, offset, length, position) {
    if (length < 0 || position < 0) {
      throw new FS.ErrnoError(22)
    }
    if (FS.isClosed(stream)) {
      throw new FS.ErrnoError(9)
    }
    if ((stream.flags & 2097155) === 1) {
      throw new FS.ErrnoError(9)
    }
    if (FS.isDir(stream.node.mode)) {
      throw new FS.ErrnoError(21)
    }
    if (!stream.stream_ops.read) {
      throw new FS.ErrnoError(22)
    }
    var seeking = typeof position !== "undefined";
    if (!seeking) {
      position = stream.position
    } else if (!stream.seekable) {
      throw new FS.ErrnoError(29)
    }
    var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
    if (!seeking) stream.position += bytesRead;
    return bytesRead
  },
  write: function (stream, buffer, offset, length, position, canOwn) {
    if (length < 0 || position < 0) {
      throw new FS.ErrnoError(22)
    }
    if (FS.isClosed(stream)) {
      throw new FS.ErrnoError(9)
    }
    if ((stream.flags & 2097155) === 0) {
      throw new FS.ErrnoError(9)
    }
    if (FS.isDir(stream.node.mode)) {
      throw new FS.ErrnoError(21)
    }
    if (!stream.stream_ops.write) {
      throw new FS.ErrnoError(22)
    }
    if (stream.flags & 1024) {
      FS.llseek(stream, 0, 2)
    }
    var seeking = typeof position !== "undefined";
    if (!seeking) {
      position = stream.position
    } else if (!stream.seekable) {
      throw new FS.ErrnoError(29)
    }
    var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
    if (!seeking) stream.position += bytesWritten;
    try {
      if (stream.path && FS.trackingDelegate["onWriteToFile"]) FS.trackingDelegate["onWriteToFile"](stream.path)
    } catch (e) {
      console.log("FS.trackingDelegate['onWriteToFile']('" + stream.path + "') threw an exception: " + e.message)
    }
    return bytesWritten
  },
  allocate: function (stream, offset, length) {
    if (FS.isClosed(stream)) {
      throw new FS.ErrnoError(9)
    }
    if (offset < 0 || length <= 0) {
      throw new FS.ErrnoError(22)
    }
    if ((stream.flags & 2097155) === 0) {
      throw new FS.ErrnoError(9)
    }
    if (!FS.isFile(stream.node.mode) && !FS.isDir(stream.node.mode)) {
      throw new FS.ErrnoError(19)
    }
    if (!stream.stream_ops.allocate) {
      throw new FS.ErrnoError(95)
    }
    stream.stream_ops.allocate(stream, offset, length)
  },
  mmap: function (stream, buffer, offset, length, position, prot, flags) {
    if ((stream.flags & 2097155) === 1) {
      throw new FS.ErrnoError(13)
    }
    if (!stream.stream_ops.mmap) {
      throw new FS.ErrnoError(19)
    }
    return stream.stream_ops.mmap(stream, buffer, offset, length, position, prot, flags)
  },
  msync: function (stream, buffer, offset, length, mmapFlags) {
    if (!stream || !stream.stream_ops.msync) {
      return 0
    }
    return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags)
  },
  munmap: function (stream) {
    return 0
  },
  ioctl: function (stream, cmd, arg) {
    if (!stream.stream_ops.ioctl) {
      throw new FS.ErrnoError(25)
    }
    return stream.stream_ops.ioctl(stream, cmd, arg)
  },
  readFile: function (path, opts) {
    opts = opts || {};
    opts.flags = opts.flags || "r";
    opts.encoding = opts.encoding || "binary";
    if (opts.encoding !== "utf8" && opts.encoding !== "binary") {
      throw new Error('Invalid encoding type "' + opts.encoding + '"')
    }
    var ret;
    var stream = FS.open(path, opts.flags);
    var stat = FS.stat(path);
    var length = stat.size;
    var buf = new Uint8Array(length);
    FS.read(stream, buf, 0, length, 0);
    if (opts.encoding === "utf8") {
      ret = UTF8ArrayToString(buf, 0)
    } else if (opts.encoding === "binary") {
      ret = buf
    }
    FS.close(stream);
    return ret
  },
  writeFile: function (path, data, opts) {
    opts = opts || {};
    opts.flags = opts.flags || "w";
    var stream = FS.open(path, opts.flags, opts.mode);
    if (typeof data === "string") {
      var buf = new Uint8Array(lengthBytesUTF8(data) + 1);
      var actualNumBytes = stringToUTF8Array(data, buf, 0, buf.length);
      FS.write(stream, buf, 0, actualNumBytes, undefined, opts.canOwn)
    } else if (ArrayBuffer.isView(data)) {
      FS.write(stream, data, 0, data.byteLength, undefined, opts.canOwn)
    } else {
      throw new Error("Unsupported data type")
    }
    FS.close(stream)
  },
  cwd: function () {
    return FS.currentPath
  },
  chdir: function (path) {
    var lookup = FS.lookupPath(path, {
      follow: true
    });
    if (lookup.node === null) {
      throw new FS.ErrnoError(2)
    }
    if (!FS.isDir(lookup.node.mode)) {
      throw new FS.ErrnoError(20)
    }
    var err = FS.nodePermissions(lookup.node, "x");
    if (err) {
      throw new FS.ErrnoError(err)
    }
    FS.currentPath = lookup.path
  },
  createDefaultDirectories: function () {
    FS.mkdir("/tmp");
    FS.mkdir("/home");
    FS.mkdir("/home/web_user")
  },
  createDefaultDevices: function () {
    FS.mkdir("/dev");
    FS.registerDevice(FS.makedev(1, 3), {
      read: function () {
        return 0
      },
      write: function (stream, buffer, offset, length, pos) {
        return length
      }
    });
    FS.mkdev("/dev/null", FS.makedev(1, 3));
    TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
    TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
    FS.mkdev("/dev/tty", FS.makedev(5, 0));
    FS.mkdev("/dev/tty1", FS.makedev(6, 0));
    var random_device;
    if (typeof crypto === "object" && typeof crypto["getRandomValues"] === "function") {
      var randomBuffer = new Uint8Array(1);
      random_device = function () {
        crypto.getRandomValues(randomBuffer);
        return randomBuffer[0]
      }
    } else if (ENVIRONMENT_IS_NODE) {
      try {
        var crypto_module = require("crypto");
        random_device = function () {
          return crypto_module["randomBytes"](1)[0]
        }
      } catch (e) {}
    } else {}
    if (!random_device) {
      random_device = function () {
        abort("random_device")
      }
    }
    FS.createDevice("/dev", "random", random_device);
    FS.createDevice("/dev", "urandom", random_device);
    FS.mkdir("/dev/shm");
    FS.mkdir("/dev/shm/tmp")
  },
  createSpecialDirectories: function () {
    FS.mkdir("/proc");
    FS.mkdir("/proc/self");
    FS.mkdir("/proc/self/fd");
    FS.mount({
      mount: function () {
        var node = FS.createNode("/proc/self", "fd", 16384 | 511, 73);
        node.node_ops = {
          lookup: function (parent, name) {
            var fd = +name;
            var stream = FS.getStream(fd);
            if (!stream) throw new FS.ErrnoError(9);
            var ret = {
              parent: null,
              mount: {
                mountpoint: "fake"
              },
              node_ops: {
                readlink: function () {
                  return stream.path
                }
              }
            };
            ret.parent = ret;
            return ret
          }
        };
        return node
      }
    }, {}, "/proc/self/fd")
  },
  createStandardStreams: function () {
    if (Module["stdin"]) {
      FS.createDevice("/dev", "stdin", Module["stdin"])
    } else {
      FS.symlink("/dev/tty", "/dev/stdin")
    }
    if (Module["stdout"]) {
      FS.createDevice("/dev", "stdout", null, Module["stdout"])
    } else {
      FS.symlink("/dev/tty", "/dev/stdout")
    }
    if (Module["stderr"]) {
      FS.createDevice("/dev", "stderr", null, Module["stderr"])
    } else {
      FS.symlink("/dev/tty1", "/dev/stderr")
    }
    var stdin = FS.open("/dev/stdin", "r");
    var stdout = FS.open("/dev/stdout", "w");
    var stderr = FS.open("/dev/stderr", "w")
  },
  ensureErrnoError: function () {
    if (FS.ErrnoError) return;
    FS.ErrnoError = function ErrnoError(errno, node) {
      this.node = node;
      this.setErrno = function (errno) {
        this.errno = errno
      };
      this.setErrno(errno);
      this.message = "FS error";
      if (this.stack) Object.defineProperty(this, "stack", {
        value: (new Error).stack,
        writable: true
      })
    };
    FS.ErrnoError.prototype = new Error;
    FS.ErrnoError.prototype.constructor = FS.ErrnoError;
    [2].forEach(function (code) {
      FS.genericErrors[code] = new FS.ErrnoError(code);
      FS.genericErrors[code].stack = "<generic error, no stack>"
    })
  },
  staticInit: function () {
    FS.ensureErrnoError();
    FS.nameTable = new Array(4096);
    FS.mount(MEMFS, {}, "/");
    FS.createDefaultDirectories();
    FS.createDefaultDevices();
    FS.createSpecialDirectories();
    FS.filesystems = {
      "MEMFS": MEMFS,
      "IDBFS": IDBFS,
      "NODEFS": NODEFS,
      "WORKERFS": WORKERFS
    }
  },
  init: function (input, output, error) {
    FS.init.initialized = true;
    FS.ensureErrnoError();
    Module["stdin"] = input || Module["stdin"];
    Module["stdout"] = output || Module["stdout"];
    Module["stderr"] = error || Module["stderr"];
    FS.createStandardStreams()
  },
  quit: function () {
    FS.init.initialized = false;
    var fflush = Module["_fflush"];
    if (fflush) fflush(0);
    for (var i = 0; i < FS.streams.length; i++) {
      var stream = FS.streams[i];
      if (!stream) {
        continue
      }
      FS.close(stream)
    }
  },
  getMode: function (canRead, canWrite) {
    var mode = 0;
    if (canRead) mode |= 292 | 73;
    if (canWrite) mode |= 146;
    return mode
  },
  joinPath: function (parts, forceRelative) {
    var path = PATH.join.apply(null, parts);
    if (forceRelative && path[0] == "/") path = path.substr(1);
    return path
  },
  absolutePath: function (relative, base) {
    return PATH.resolve(base, relative)
  },
  standardizePath: function (path) {
    return PATH.normalize(path)
  },
  findObject: function (path, dontResolveLastLink) {
    var ret = FS.analyzePath(path, dontResolveLastLink);
    if (ret.exists) {
      return ret.object
    } else {
      ___setErrNo(ret.error);
      return null
    }
  },
  analyzePath: function (path, dontResolveLastLink) {
    try {
      var lookup = FS.lookupPath(path, {
        follow: !dontResolveLastLink
      });
      path = lookup.path
    } catch (e) {}
    var ret = {
      isRoot: false,
      exists: false,
      error: 0,
      name: null,
      path: null,
      object: null,
      parentExists: false,
      parentPath: null,
      parentObject: null
    };
    try {
      var lookup = FS.lookupPath(path, {
        parent: true
      });
      ret.parentExists = true;
      ret.parentPath = lookup.path;
      ret.parentObject = lookup.node;
      ret.name = PATH.basename(path);
      lookup = FS.lookupPath(path, {
        follow: !dontResolveLastLink
      });
      ret.exists = true;
      ret.path = lookup.path;
      ret.object = lookup.node;
      ret.name = lookup.node.name;
      ret.isRoot = lookup.path === "/"
    } catch (e) {
      ret.error = e.errno
    }
    return ret
  },
  createFolder: function (parent, name, canRead, canWrite) {
    var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name);
    var mode = FS.getMode(canRead, canWrite);
    return FS.mkdir(path, mode)
  },
  createPath: function (parent, path, canRead, canWrite) {
    parent = typeof parent === "string" ? parent : FS.getPath(parent);
    var parts = path.split("/").reverse();
    while (parts.length) {
      var part = parts.pop();
      if (!part) continue;
      var current = PATH.join2(parent, part);
      try {
        FS.mkdir(current)
      } catch (e) {}
      parent = current
    }
    return current
  },
  createFile: function (parent, name, properties, canRead, canWrite) {
    var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name);
    var mode = FS.getMode(canRead, canWrite);
    return FS.create(path, mode)
  },
  createDataFile: function (parent, name, data, canRead, canWrite, canOwn) {
    var path = name ? PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name) : parent;
    var mode = FS.getMode(canRead, canWrite);
    var node = FS.create(path, mode);
    if (data) {
      if (typeof data === "string") {
        var arr = new Array(data.length);
        for (var i = 0, len = data.length; i < len; ++i) arr[i] = data.charCodeAt(i);
        data = arr
      }
      FS.chmod(node, mode | 146);
      var stream = FS.open(node, "w");
      FS.write(stream, data, 0, data.length, 0, canOwn);
      FS.close(stream);
      FS.chmod(node, mode)
    }
    return node
  },
  createDevice: function (parent, name, input, output) {
    var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name);
    var mode = FS.getMode(!!input, !!output);
    if (!FS.createDevice.major) FS.createDevice.major = 64;
    var dev = FS.makedev(FS.createDevice.major++, 0);
    FS.registerDevice(dev, {
      open: function (stream) {
        stream.seekable = false
      },
      close: function (stream) {
        if (output && output.buffer && output.buffer.length) {
          output(10)
        }
      },
      read: function (stream, buffer, offset, length, pos) {
        var bytesRead = 0;
        for (var i = 0; i < length; i++) {
          var result;
          try {
            result = input()
          } catch (e) {
            throw new FS.ErrnoError(5)
          }
          if (result === undefined && bytesRead === 0) {
            throw new FS.ErrnoError(11)
          }
          if (result === null || result === undefined) break;
          bytesRead++;
          buffer[offset + i] = result
        }
        if (bytesRead) {
          stream.node.timestamp = Date.now()
        }
        return bytesRead
      },
      write: function (stream, buffer, offset, length, pos) {
        for (var i = 0; i < length; i++) {
          try {
            output(buffer[offset + i])
          } catch (e) {
            throw new FS.ErrnoError(5)
          }
        }
        if (length) {
          stream.node.timestamp = Date.now()
        }
        return i
      }
    });
    return FS.mkdev(path, mode, dev)
  },
  createLink: function (parent, name, target, canRead, canWrite) {
    var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name);
    return FS.symlink(target, path)
  },
  forceLoadFile: function (obj) {
    if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
    var success = true;
    if (typeof XMLHttpRequest !== "undefined") {
      throw new Error("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.")
    } else if (Module["read"]) {
      try {
        obj.contents = intArrayFromString(Module["read"](obj.url), true);
        obj.usedBytes = obj.contents.length
      } catch (e) {
        success = false
      }
    } else {
      throw new Error("Cannot load without read() or XMLHttpRequest.")
    }
    if (!success) ___setErrNo(5);
    return success
  },
  createLazyFile: function (parent, name, url, canRead, canWrite) {
    function LazyUint8Array() {
      this.lengthKnown = false;
      this.chunks = []
    }
    LazyUint8Array.prototype.get = function LazyUint8Array_get(idx) {
      if (idx > this.length - 1 || idx < 0) {
        return undefined
      }
      var chunkOffset = idx % this.chunkSize;
      var chunkNum = idx / this.chunkSize | 0;
      return this.getter(chunkNum)[chunkOffset]
    };
    LazyUint8Array.prototype.setDataGetter = function LazyUint8Array_setDataGetter(getter) {
      this.getter = getter
    };
    LazyUint8Array.prototype.cacheLength = function LazyUint8Array_cacheLength() {
      var xhr = new XMLHttpRequest;
      xhr.open("HEAD", url, false);
      xhr.send(null);
      if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
      var datalength = Number(xhr.getResponseHeader("Content-length"));
      var header;
      var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
      var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
      var chunkSize = 1024 * 1024;
      if (!hasByteServing) chunkSize = datalength;
      var doXHR = function (from, to) {
        if (from > to) throw new Error("invalid range (" + from + ", " + to + ") or no bytes requested!");
        if (to > datalength - 1) throw new Error("only " + datalength + " bytes available! programmer error!");
        var xhr = new XMLHttpRequest;
        xhr.open("GET", url, false);
        if (datalength !== chunkSize) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);
        if (typeof Uint8Array != "undefined") xhr.responseType = "arraybuffer";
        if (xhr.overrideMimeType) {
          xhr.overrideMimeType("text/plain; charset=x-user-defined")
        }
        xhr.send(null);
        if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
        if (xhr.response !== undefined) {
          return new Uint8Array(xhr.response || [])
        } else {
          return intArrayFromString(xhr.responseText || "", true)
        }
      };
      var lazyArray = this;
      lazyArray.setDataGetter(function (chunkNum) {
        var start = chunkNum * chunkSize;
        var end = (chunkNum + 1) * chunkSize - 1;
        end = Math.min(end, datalength - 1);
        if (typeof lazyArray.chunks[chunkNum] === "undefined") {
          lazyArray.chunks[chunkNum] = doXHR(start, end)
        }
        if (typeof lazyArray.chunks[chunkNum] === "undefined") throw new Error("doXHR failed!");
        return lazyArray.chunks[chunkNum]
      });
      if (usesGzip || !datalength) {
        chunkSize = datalength = 1;
        datalength = this.getter(0).length;
        chunkSize = datalength;
        console.log("LazyFiles on gzip forces download of the whole file when length is accessed")
      }
      this._length = datalength;
      this._chunkSize = chunkSize;
      this.lengthKnown = true
    };
    if (typeof XMLHttpRequest !== "undefined") {
      if (!ENVIRONMENT_IS_WORKER) throw "Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc";
      var lazyArray = new LazyUint8Array;
      Object.defineProperties(lazyArray, {
        length: {
          get: function () {
            if (!this.lengthKnown) {
              this.cacheLength()
            }
            return this._length
          }
        },
        chunkSize: {
          get: function () {
            if (!this.lengthKnown) {
              this.cacheLength()
            }
            return this._chunkSize
          }
        }
      });
      var properties = {
        isDevice: false,
        contents: lazyArray
      }
    } else {
      var properties = {
        isDevice: false,
        url: url
      }
    }
    var node = FS.createFile(parent, name, properties, canRead, canWrite);
    if (properties.contents) {
      node.contents = properties.contents
    } else if (properties.url) {
      node.contents = null;
      node.url = properties.url
    }
    Object.defineProperties(node, {
      usedBytes: {
        get: function () {
          return this.contents.length
        }
      }
    });
    var stream_ops = {};
    var keys = Object.keys(node.stream_ops);
    keys.forEach(function (key) {
      var fn = node.stream_ops[key];
      stream_ops[key] = function forceLoadLazyFile() {
        if (!FS.forceLoadFile(node)) {
          throw new FS.ErrnoError(5)
        }
        return fn.apply(null, arguments)
      }
    });
    stream_ops.read = function stream_ops_read(stream, buffer, offset, length, position) {
      if (!FS.forceLoadFile(node)) {
        throw new FS.ErrnoError(5)
      }
      var contents = stream.node.contents;
      if (position >= contents.length) return 0;
      var size = Math.min(contents.length - position, length);
      if (contents.slice) {
        for (var i = 0; i < size; i++) {
          buffer[offset + i] = contents[position + i]
        }
      } else {
        for (var i = 0; i < size; i++) {
          buffer[offset + i] = contents.get(position + i)
        }
      }
      return size
    };
    node.stream_ops = stream_ops;
    return node
  },
  createPreloadedFile: function (parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) {
    Browser.init();
    var fullname = name ? PATH.resolve(PATH.join2(parent, name)) : parent;
    var dep = getUniqueRunDependency("cp " + fullname);

    function processData(byteArray) {
      function finish(byteArray) {
        if (preFinish) preFinish();
        if (!dontCreateFile) {
          FS.createDataFile(parent, name, byteArray, canRead, canWrite, canOwn)
        }
        if (onload) onload();
        removeRunDependency(dep)
      }
      var handled = false;
      Module["preloadPlugins"].forEach(function (plugin) {
        if (handled) return;
        if (plugin["canHandle"](fullname)) {
          plugin["handle"](byteArray, fullname, finish, function () {
            if (onerror) onerror();
            removeRunDependency(dep)
          });
          handled = true
        }
      });
      if (!handled) finish(byteArray)
    }
    addRunDependency(dep);
    if (typeof url == "string") {
      Browser.asyncLoad(url, function (byteArray) {
        processData(byteArray)
      }, onerror)
    } else {
      processData(url)
    }
  },
  indexedDB: function () {
    return window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB
  },
  DB_NAME: function () {
    return "EM_FS_" + window.location.pathname
  },
  DB_VERSION: 20,
  DB_STORE_NAME: "FILE_DATA",
  saveFilesToDB: function (paths, onload, onerror) {
    onload = onload || function () {};
    onerror = onerror || function () {};
    var indexedDB = FS.indexedDB();
    try {
      var openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION)
    } catch (e) {
      return onerror(e)
    }
    openRequest.onupgradeneeded = function openRequest_onupgradeneeded() {
      console.log("creating db");
      var db = openRequest.result;
      db.createObjectStore(FS.DB_STORE_NAME)
    };
    openRequest.onsuccess = function openRequest_onsuccess() {
      var db = openRequest.result;
      var transaction = db.transaction([FS.DB_STORE_NAME], "readwrite");
      var files = transaction.objectStore(FS.DB_STORE_NAME);
      var ok = 0,
        fail = 0,
        total = paths.length;

      function finish() {
        if (fail == 0) onload();
        else onerror()
      }
      paths.forEach(function (path) {
        var putRequest = files.put(FS.analyzePath(path).object.contents, path);
        putRequest.onsuccess = function putRequest_onsuccess() {
          ok++;
          if (ok + fail == total) finish()
        };
        putRequest.onerror = function putRequest_onerror() {
          fail++;
          if (ok + fail == total) finish()
        }
      });
      transaction.onerror = onerror
    };
    openRequest.onerror = onerror
  },
  loadFilesFromDB: function (paths, onload, onerror) {
    onload = onload || function () {};
    onerror = onerror || function () {};
    var indexedDB = FS.indexedDB();
    try {
      var openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION)
    } catch (e) {
      return onerror(e)
    }
    openRequest.onupgradeneeded = onerror;
    openRequest.onsuccess = function openRequest_onsuccess() {
      var db = openRequest.result;
      try {
        var transaction = db.transaction([FS.DB_STORE_NAME], "readonly")
      } catch (e) {
        onerror(e);
        return
      }
      var files = transaction.objectStore(FS.DB_STORE_NAME);
      var ok = 0,
        fail = 0,
        total = paths.length;

      function finish() {
        if (fail == 0) onload();
        else onerror()
      }
      paths.forEach(function (path) {
        var getRequest = files.get(path);
        getRequest.onsuccess = function getRequest_onsuccess() {
          if (FS.analyzePath(path).exists) {
            FS.unlink(path)
          }
          FS.createDataFile(PATH.dirname(path), PATH.basename(path), getRequest.result, true, true, true);
          ok++;
          if (ok + fail == total) finish()
        };
        getRequest.onerror = function getRequest_onerror() {
          fail++;
          if (ok + fail == total) finish()
        }
      });
      transaction.onerror = onerror
    };
    openRequest.onerror = onerror
  }
};
var ERRNO_CODES = {
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  EINTR: 4,
  EIO: 5,
  ENXIO: 6,
  E2BIG: 7,
  ENOEXEC: 8,
  EBADF: 9,
  ECHILD: 10,
  EAGAIN: 11,
  EWOULDBLOCK: 11,
  ENOMEM: 12,
  EACCES: 13,
  EFAULT: 14,
  ENOTBLK: 15,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENODEV: 19,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENFILE: 23,
  EMFILE: 24,
  ENOTTY: 25,
  ETXTBSY: 26,
  EFBIG: 27,
  ENOSPC: 28,
  ESPIPE: 29,
  EROFS: 30,
  EMLINK: 31,
  EPIPE: 32,
  EDOM: 33,
  ERANGE: 34,
  ENOMSG: 42,
  EIDRM: 43,
  ECHRNG: 44,
  EL2NSYNC: 45,
  EL3HLT: 46,
  EL3RST: 47,
  ELNRNG: 48,
  EUNATCH: 49,
  ENOCSI: 50,
  EL2HLT: 51,
  EDEADLK: 35,
  ENOLCK: 37,
  EBADE: 52,
  EBADR: 53,
  EXFULL: 54,
  ENOANO: 55,
  EBADRQC: 56,
  EBADSLT: 57,
  EDEADLOCK: 35,
  EBFONT: 59,
  ENOSTR: 60,
  ENODATA: 61,
  ETIME: 62,
  ENOSR: 63,
  ENONET: 64,
  ENOPKG: 65,
  EREMOTE: 66,
  ENOLINK: 67,
  EADV: 68,
  ESRMNT: 69,
  ECOMM: 70,
  EPROTO: 71,
  EMULTIHOP: 72,
  EDOTDOT: 73,
  EBADMSG: 74,
  ENOTUNIQ: 76,
  EBADFD: 77,
  EREMCHG: 78,
  ELIBACC: 79,
  ELIBBAD: 80,
  ELIBSCN: 81,
  ELIBMAX: 82,
  ELIBEXEC: 83,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ENAMETOOLONG: 36,
  ELOOP: 40,
  EOPNOTSUPP: 95,
  EPFNOSUPPORT: 96,
  ECONNRESET: 104,
  ENOBUFS: 105,
  EAFNOSUPPORT: 97,
  EPROTOTYPE: 91,
  ENOTSOCK: 88,
  ENOPROTOOPT: 92,
  ESHUTDOWN: 108,
  ECONNREFUSED: 111,
  EADDRINUSE: 98,
  ECONNABORTED: 103,
  ENETUNREACH: 101,
  ENETDOWN: 100,
  ETIMEDOUT: 110,
  EHOSTDOWN: 112,
  EHOSTUNREACH: 113,
  EINPROGRESS: 115,
  EALREADY: 114,
  EDESTADDRREQ: 89,
  EMSGSIZE: 90,
  EPROTONOSUPPORT: 93,
  ESOCKTNOSUPPORT: 94,
  EADDRNOTAVAIL: 99,
  ENETRESET: 102,
  EISCONN: 106,
  ENOTCONN: 107,
  ETOOMANYREFS: 109,
  EUSERS: 87,
  EDQUOT: 122,
  ESTALE: 116,
  ENOTSUP: 95,
  ENOMEDIUM: 123,
  EILSEQ: 84,
  EOVERFLOW: 75,
  ECANCELED: 125,
  ENOTRECOVERABLE: 131,
  EOWNERDEAD: 130,
  ESTRPIPE: 86
};
var SYSCALLS = {
  DEFAULT_POLLMASK: 5,
  mappings: {},
  umask: 511,
  calculateAt: function (dirfd, path) {
    if (path[0] !== "/") {
      var dir;
      if (dirfd === -100) {
        dir = FS.cwd()
      } else {
        var dirstream = FS.getStream(dirfd);
        if (!dirstream) throw new FS.ErrnoError(ERRNO_CODES.EBADF);
        dir = dirstream.path
      }
      path = PATH.join2(dir, path)
    }
    return path
  },
  doStat: function (func, path, buf) {
    try {
      var stat = func(path)
    } catch (e) {
      if (e && e.node && PATH.normalize(path) !== PATH.normalize(FS.getPath(e.node))) {
        return -ERRNO_CODES.ENOTDIR
      }
      throw e
    }
    HEAP32[buf >> 2] = stat.dev;
    HEAP32[buf + 4 >> 2] = 0;
    HEAP32[buf + 8 >> 2] = stat.ino;
    HEAP32[buf + 12 >> 2] = stat.mode;
    HEAP32[buf + 16 >> 2] = stat.nlink;
    HEAP32[buf + 20 >> 2] = stat.uid;
    HEAP32[buf + 24 >> 2] = stat.gid;
    HEAP32[buf + 28 >> 2] = stat.rdev;
    HEAP32[buf + 32 >> 2] = 0;
    tempI64 = [stat.size >>> 0, (tempDouble = stat.size, +Math_abs(tempDouble) >= 1 ? tempDouble > 0 ? (Math_min(+Math_floor(tempDouble / 4294967296), 4294967295) | 0) >>> 0 : ~~+Math_ceil((tempDouble - +(~~tempDouble >>> 0)) / 4294967296) >>> 0 : 0)], HEAP32[buf + 40 >> 2] = tempI64[0], HEAP32[buf + 44 >> 2] = tempI64[1];
    HEAP32[buf + 48 >> 2] = 4096;
    HEAP32[buf + 52 >> 2] = stat.blocks;
    HEAP32[buf + 56 >> 2] = stat.atime.getTime() / 1e3 | 0;
    HEAP32[buf + 60 >> 2] = 0;
    HEAP32[buf + 64 >> 2] = stat.mtime.getTime() / 1e3 | 0;
    HEAP32[buf + 68 >> 2] = 0;
    HEAP32[buf + 72 >> 2] = stat.ctime.getTime() / 1e3 | 0;
    HEAP32[buf + 76 >> 2] = 0;
    tempI64 = [stat.ino >>> 0, (tempDouble = stat.ino, +Math_abs(tempDouble) >= 1 ? tempDouble > 0 ? (Math_min(+Math_floor(tempDouble / 4294967296), 4294967295) | 0) >>> 0 : ~~+Math_ceil((tempDouble - +(~~tempDouble >>> 0)) / 4294967296) >>> 0 : 0)], HEAP32[buf + 80 >> 2] = tempI64[0], HEAP32[buf + 84 >> 2] = tempI64[1];
    return 0
  },
  doMsync: function (addr, stream, len, flags) {
    var buffer = new Uint8Array(HEAPU8.subarray(addr, addr + len));
    FS.msync(stream, buffer, 0, len, flags)
  },
  doMkdir: function (path, mode) {
    path = PATH.normalize(path);
    if (path[path.length - 1] === "/") path = path.substr(0, path.length - 1);
    FS.mkdir(path, mode, 0);
    return 0
  },
  doMknod: function (path, mode, dev) {
    switch (mode & 61440) {
    case 32768:
    case 8192:
    case 24576:
    case 4096:
    case 49152:
      break;
    default:
      return -ERRNO_CODES.EINVAL
    }
    FS.mknod(path, mode, dev);
    return 0
  },
  doReadlink: function (path, buf, bufsize) {
    if (bufsize <= 0) return -ERRNO_CODES.EINVAL;
    var ret = FS.readlink(path);
    var len = Math.min(bufsize, lengthBytesUTF8(ret));
    var endChar = HEAP8[buf + len];
    stringToUTF8(ret, buf, bufsize + 1);
    HEAP8[buf + len] = endChar;
    return len
  },
  doAccess: function (path, amode) {
    if (amode & ~7) {
      return -ERRNO_CODES.EINVAL
    }
    var node;
    var lookup = FS.lookupPath(path, {
      follow: true
    });
    node = lookup.node;
    var perms = "";
    if (amode & 4) perms += "r";
    if (amode & 2) perms += "w";
    if (amode & 1) perms += "x";
    if (perms && FS.nodePermissions(node, perms)) {
      return -ERRNO_CODES.EACCES
    }
    return 0
  },
  doDup: function (path, flags, suggestFD) {
    var suggest = FS.getStream(suggestFD);
    if (suggest) FS.close(suggest);
    return FS.open(path, flags, 0, suggestFD, suggestFD).fd
  },
  doReadv: function (stream, iov, iovcnt, offset) {
    var ret = 0;
    for (var i = 0; i < iovcnt; i++) {
      var ptr = HEAP32[iov + i * 8 >> 2];
      var len = HEAP32[iov + (i * 8 + 4) >> 2];
      var curr = FS.read(stream, HEAP8, ptr, len, offset);
      if (curr < 0) return -1;
      ret += curr;
      if (curr < len) break
    }
    return ret
  },
  doWritev: function (stream, iov, iovcnt, offset) {
    var ret = 0;
    for (var i = 0; i < iovcnt; i++) {
      var ptr = HEAP32[iov + i * 8 >> 2];
      var len = HEAP32[iov + (i * 8 + 4) >> 2];
      var curr = FS.write(stream, HEAP8, ptr, len, offset);
      if (curr < 0) return -1;
      ret += curr
    }
    return ret
  },
  varargs: 0,
  get: function (varargs) {
    SYSCALLS.varargs += 4;
    var ret = HEAP32[SYSCALLS.varargs - 4 >> 2];
    return ret
  },
  getStr: function () {
    var ret = UTF8ToString(SYSCALLS.get());
    return ret
  },
  getStreamFromFD: function () {
    var stream = FS.getStream(SYSCALLS.get());
    if (!stream) throw new FS.ErrnoError(ERRNO_CODES.EBADF);
    return stream
  },
  getSocketFromFD: function () {
    var socket = SOCKFS.getSocket(SYSCALLS.get());
    if (!socket) throw new FS.ErrnoError(ERRNO_CODES.EBADF);
    return socket
  },
  getSocketAddress: function (allowNull) {
    var addrp = SYSCALLS.get(),
      addrlen = SYSCALLS.get();
    if (allowNull && addrp === 0) return null;
    var info = __read_sockaddr(addrp, addrlen);
    if (info.errno) throw new FS.ErrnoError(info.errno);
    info.addr = DNS.lookup_addr(info.addr) || info.addr;
    return info
  },
  get64: function () {
    var low = SYSCALLS.get(),
      high = SYSCALLS.get();
    return low
  },
  getZero: function () {
    SYSCALLS.get()
  }
};

function ___syscall10(which, varargs) {
  SYSCALLS.varargs = varargs;
  try {
    var path = SYSCALLS.getStr();
    FS.unlink(path);
    return 0
  } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno
  }
}

function ___syscall140(which, varargs) {
  SYSCALLS.varargs = varargs;
  try {
    var stream = SYSCALLS.getStreamFromFD(),
      offset_high = SYSCALLS.get(),
      offset_low = SYSCALLS.get(),
      result = SYSCALLS.get(),
      whence = SYSCALLS.get();
    if (!(offset_high == -1 && offset_low < 0) && !(offset_high == 0 && offset_low >= 0)) {
      return -ERRNO_CODES.EOVERFLOW
    }
    var offset = offset_low;
    FS.llseek(stream, offset, whence);
    tempI64 = [stream.position >>> 0, (tempDouble = stream.position, +Math_abs(tempDouble) >= 1 ? tempDouble > 0 ? (Math_min(+Math_floor(tempDouble / 4294967296), 4294967295) | 0) >>> 0 : ~~+Math_ceil((tempDouble - +(~~tempDouble >>> 0)) / 4294967296) >>> 0 : 0)], HEAP32[result >> 2] = tempI64[0], HEAP32[result + 4 >> 2] = tempI64[1];
    if (stream.getdents && offset === 0 && whence === 0) stream.getdents = null;
    return 0
  } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno
  }
}

function ___syscall145(which, varargs) {
  SYSCALLS.varargs = varargs;
  try {
    var stream = SYSCALLS.getStreamFromFD(),
      iov = SYSCALLS.get(),
      iovcnt = SYSCALLS.get();
    return SYSCALLS.doReadv(stream, iov, iovcnt)
  } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno
  }
}

function ___syscall146(which, varargs) {
  SYSCALLS.varargs = varargs;
  try {
    var stream = SYSCALLS.getStreamFromFD(),
      iov = SYSCALLS.get(),
      iovcnt = SYSCALLS.get();
    return SYSCALLS.doWritev(stream, iov, iovcnt)
  } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno
  }
}

function ___syscall221(which, varargs) {
  SYSCALLS.varargs = varargs;
  try {
    var stream = SYSCALLS.getStreamFromFD(),
      cmd = SYSCALLS.get();
    switch (cmd) {
    case 0:
      {
        var arg = SYSCALLS.get();
        if (arg < 0) {
          return -ERRNO_CODES.EINVAL
        }
        var newStream;newStream = FS.open(stream.path, stream.flags, 0, arg);
        return newStream.fd
      }
    case 1:
    case 2:
      return 0;
    case 3:
      return stream.flags;
    case 4:
      {
        var arg = SYSCALLS.get();stream.flags |= arg;
        return 0
      }
    case 12:
      {
        var arg = SYSCALLS.get();
        var offset = 0;HEAP16[arg + offset >> 1] = 2;
        return 0
      }
    case 13:
    case 14:
      return 0;
    case 16:
    case 8:
      return -ERRNO_CODES.EINVAL;
    case 9:
      ___setErrNo(ERRNO_CODES.EINVAL);
      return -1;
    default:
      {
        return -ERRNO_CODES.EINVAL
      }
    }
  } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno
  }
}

function ___syscall5(which, varargs) {
  SYSCALLS.varargs = varargs;
  try {
    var pathname = SYSCALLS.getStr(),
      flags = SYSCALLS.get(),
      mode = SYSCALLS.get();
    var stream = FS.open(pathname, flags, mode);
    return stream.fd
  } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno
  }
}

function ___syscall54(which, varargs) {
  SYSCALLS.varargs = varargs;
  try {
    var stream = SYSCALLS.getStreamFromFD(),
      op = SYSCALLS.get();
    switch (op) {
    case 21509:
    case 21505:
      {
        if (!stream.tty) return -ERRNO_CODES.ENOTTY;
        return 0
      }
    case 21510:
    case 21511:
    case 21512:
    case 21506:
    case 21507:
    case 21508:
      {
        if (!stream.tty) return -ERRNO_CODES.ENOTTY;
        return 0
      }
    case 21519:
      {
        if (!stream.tty) return -ERRNO_CODES.ENOTTY;
        var argp = SYSCALLS.get();HEAP32[argp >> 2] = 0;
        return 0
      }
    case 21520:
      {
        if (!stream.tty) return -ERRNO_CODES.ENOTTY;
        return -ERRNO_CODES.EINVAL
      }
    case 21531:
      {
        var argp = SYSCALLS.get();
        return FS.ioctl(stream, op, argp)
      }
    case 21523:
      {
        if (!stream.tty) return -ERRNO_CODES.ENOTTY;
        return 0
      }
    case 21524:
      {
        if (!stream.tty) return -ERRNO_CODES.ENOTTY;
        return 0
      }
    default:
      abort("bad ioctl syscall " + op)
    }
  } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno
  }
}

function ___syscall6(which, varargs) {
  SYSCALLS.varargs = varargs;
  try {
    var stream = SYSCALLS.getStreamFromFD();
    FS.close(stream);
    return 0
  } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno
  }
}

function ___syscall91(which, varargs) {
  SYSCALLS.varargs = varargs;
  try {
    var addr = SYSCALLS.get(),
      len = SYSCALLS.get();
    var info = SYSCALLS.mappings[addr];
    if (!info) return 0;
    if (len === info.len) {
      var stream = FS.getStream(info.fd);
      SYSCALLS.doMsync(addr, stream, len, info.flags);
      FS.munmap(stream);
      SYSCALLS.mappings[addr] = null;
      if (info.allocated) {
        _free(info.malloc)
      }
    }
    return 0
  } catch (e) {
    if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e);
    return -e.errno
  }
}

function ___unlock() {}

function getShiftFromSize(size) {
  switch (size) {
  case 1:
    return 0;
  case 2:
    return 1;
  case 4:
    return 2;
  case 8:
    return 3;
  default:
    throw new TypeError("Unknown type size: " + size)
  }
}

function embind_init_charCodes() {
  var codes = new Array(256);
  for (var i = 0; i < 256; ++i) {
    codes[i] = String.fromCharCode(i)
  }
  embind_charCodes = codes
}
var embind_charCodes = undefined;

function readLatin1String(ptr) {
  var ret = "";
  var c = ptr;
  while (HEAPU8[c]) {
    ret += embind_charCodes[HEAPU8[c++]]
  }
  return ret
}
var awaitingDependencies = {};
var registeredTypes = {};
var typeDependencies = {};
var char_0 = 48;
var char_9 = 57;

function makeLegalFunctionName(name) {
  if (undefined === name) {
    return "_unknown"
  }
  name = name.replace(/[^a-zA-Z0-9_]/g, "$");
  var f = name.charCodeAt(0);
  if (f >= char_0 && f <= char_9) {
    return "_" + name
  } else {
    return name
  }
}

function createNamedFunction(name, body) {
  name = makeLegalFunctionName(name);
  return new Function("body", "return function " + name + "() {\n" + '    "use strict";' + "    return body.apply(this, arguments);\n" + "};\n")(body)
}

function extendError(baseErrorType, errorName) {
  var errorClass = createNamedFunction(errorName, function (message) {
    this.name = errorName;
    this.message = message;
    var stack = new Error(message).stack;
    if (stack !== undefined) {
      this.stack = this.toString() + "\n" + stack.replace(/^Error(:[^\n]*)?\n/, "")
    }
  });
  errorClass.prototype = Object.create(baseErrorType.prototype);
  errorClass.prototype.constructor = errorClass;
  errorClass.prototype.toString = function () {
    if (this.message === undefined) {
      return this.name
    } else {
      return this.name + ": " + this.message
    }
  };
  return errorClass
}
var BindingError = undefined;

function throwBindingError(message) {
  throw new BindingError(message)
}
var InternalError = undefined;

function throwInternalError(message) {
  throw new InternalError(message)
}

function whenDependentTypesAreResolved(myTypes, dependentTypes, getTypeConverters) {
  myTypes.forEach(function (type) {
    typeDependencies[type] = dependentTypes
  });

  function onComplete(typeConverters) {
    var myTypeConverters = getTypeConverters(typeConverters);
    if (myTypeConverters.length !== myTypes.length) {
      throwInternalError("Mismatched type converter count")
    }
    for (var i = 0; i < myTypes.length; ++i) {
      registerType(myTypes[i], myTypeConverters[i])
    }
  }
  var typeConverters = new Array(dependentTypes.length);
  var unregisteredTypes = [];
  var registered = 0;
  dependentTypes.forEach(function (dt, i) {
    if (registeredTypes.hasOwnProperty(dt)) {
      typeConverters[i] = registeredTypes[dt]
    } else {
      unregisteredTypes.push(dt);
      if (!awaitingDependencies.hasOwnProperty(dt)) {
        awaitingDependencies[dt] = []
      }
      awaitingDependencies[dt].push(function () {
        typeConverters[i] = registeredTypes[dt];
        ++registered;
        if (registered === unregisteredTypes.length) {
          onComplete(typeConverters)
        }
      })
    }
  });
  if (0 === unregisteredTypes.length) {
    onComplete(typeConverters)
  }
}

function registerType(rawType, registeredInstance, options) {
  options = options || {};
  if (!("argPackAdvance" in registeredInstance)) {
    throw new TypeError("registerType registeredInstance requires argPackAdvance")
  }
  var name = registeredInstance.name;
  if (!rawType) {
    throwBindingError('type "' + name + '" must have a positive integer typeid pointer')
  }
  if (registeredTypes.hasOwnProperty(rawType)) {
    if (options.ignoreDuplicateRegistrations) {
      return
    } else {
      throwBindingError("Cannot register type '" + name + "' twice")
    }
  }
  registeredTypes[rawType] = registeredInstance;
  delete typeDependencies[rawType];
  if (awaitingDependencies.hasOwnProperty(rawType)) {
    var callbacks = awaitingDependencies[rawType];
    delete awaitingDependencies[rawType];
    callbacks.forEach(function (cb) {
      cb()
    })
  }
}

function __embind_register_bool(rawType, name, size, trueValue, falseValue) {
  var shift = getShiftFromSize(size);
  name = readLatin1String(name);
  registerType(rawType, {
    name: name,
    "fromWireType": function (wt) {
      return !!wt
    },
    "toWireType": function (destructors, o) {
      return o ? trueValue : falseValue
    },
    "argPackAdvance": 8,
    "readValueFromPointer": function (pointer) {
      var heap;
      if (size === 1) {
        heap = HEAP8
      } else if (size === 2) {
        heap = HEAP16
      } else if (size === 4) {
        heap = HEAP32
      } else {
        throw new TypeError("Unknown boolean type size: " + name)
      }
      return this["fromWireType"](heap[pointer >> shift])
    },
    destructorFunction: null
  })
}

function __embind_register_constant(name, type, value) {
  name = readLatin1String(name);
  whenDependentTypesAreResolved([], [type], function (type) {
    type = type[0];
    Module[name] = type["fromWireType"](value);
    return []
  })
}
var emval_free_list = [];
var emval_handle_array = [{}, {
  value: undefined
}, {
  value: null
}, {
  value: true
}, {
  value: false
}];

function __emval_decref(handle) {
  if (handle > 4 && 0 === --emval_handle_array[handle].refcount) {
    emval_handle_array[handle] = undefined;
    emval_free_list.push(handle)
  }
}

function count_emval_handles() {
  var count = 0;
  for (var i = 5; i < emval_handle_array.length; ++i) {
    if (emval_handle_array[i] !== undefined) {
      ++count
    }
  }
  return count
}

function get_first_emval() {
  for (var i = 5; i < emval_handle_array.length; ++i) {
    if (emval_handle_array[i] !== undefined) {
      return emval_handle_array[i]
    }
  }
  return null
}

function init_emval() {
  Module["count_emval_handles"] = count_emval_handles;
  Module["get_first_emval"] = get_first_emval
}

function __emval_register(value) {
  switch (value) {
  case undefined:
    {
      return 1
    }
  case null:
    {
      return 2
    }
  case true:
    {
      return 3
    }
  case false:
    {
      return 4
    }
  default:
    {
      var handle = emval_free_list.length ? emval_free_list.pop() : emval_handle_array.length;emval_handle_array[handle] = {
        refcount: 1,
        value: value
      };
      return handle
    }
  }
}

function simpleReadValueFromPointer(pointer) {
  return this["fromWireType"](HEAPU32[pointer >> 2])
}

function __embind_register_emval(rawType, name) {
  name = readLatin1String(name);
  registerType(rawType, {
    name: name,
    "fromWireType": function (handle) {
      var rv = emval_handle_array[handle].value;
      __emval_decref(handle);
      return rv
    },
    "toWireType": function (destructors, value) {
      return __emval_register(value)
    },
    "argPackAdvance": 8,
    "readValueFromPointer": simpleReadValueFromPointer,
    destructorFunction: null
  })
}

function _embind_repr(v) {
  if (v === null) {
    return "null"
  }
  var t = typeof v;
  if (t === "object" || t === "array" || t === "function") {
    return v.toString()
  } else {
    return "" + v
  }
}

function floatReadValueFromPointer(name, shift) {
  switch (shift) {
  case 2:
    return function (pointer) {
      return this["fromWireType"](HEAPF32[pointer >> 2])
    };
  case 3:
    return function (pointer) {
      return this["fromWireType"](HEAPF64[pointer >> 3])
    };
  default:
    throw new TypeError("Unknown float type: " + name)
  }
}

function __embind_register_float(rawType, name, size) {
  var shift = getShiftFromSize(size);
  name = readLatin1String(name);
  registerType(rawType, {
    name: name,
    "fromWireType": function (value) {
      return value
    },
    "toWireType": function (destructors, value) {
      if (typeof value !== "number" && typeof value !== "boolean") {
        throw new TypeError('Cannot convert "' + _embind_repr(value) + '" to ' + this.name)
      }
      return value
    },
    "argPackAdvance": 8,
    "readValueFromPointer": floatReadValueFromPointer(name, shift),
    destructorFunction: null
  })
}

function new_(constructor, argumentList) {
  if (!(constructor instanceof Function)) {
    throw new TypeError("new_ called with constructor type " + typeof constructor + " which is not a function")
  }
  var dummy = createNamedFunction(constructor.name || "unknownFunctionName", function () {});
  dummy.prototype = constructor.prototype;
  var obj = new dummy;
  var r = constructor.apply(obj, argumentList);
  return r instanceof Object ? r : obj
}

function runDestructors(destructors) {
  while (destructors.length) {
    var ptr = destructors.pop();
    var del = destructors.pop();
    del(ptr)
  }
}

function craftInvokerFunction(humanName, argTypes, classType, cppInvokerFunc, cppTargetFunc) {
  var argCount = argTypes.length;
  if (argCount < 2) {
    throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!")
  }
  var isClassMethodFunc = argTypes[1] !== null && classType !== null;
  var needsDestructorStack = false;
  for (var i = 1; i < argTypes.length; ++i) {
    if (argTypes[i] !== null && argTypes[i].destructorFunction === undefined) {
      needsDestructorStack = true;
      break
    }
  }
  var returns = argTypes[0].name !== "void";
  var argsList = "";
  var argsListWired = "";
  for (var i = 0; i < argCount - 2; ++i) {
    argsList += (i !== 0 ? ", " : "") + "arg" + i;
    argsListWired += (i !== 0 ? ", " : "") + "arg" + i + "Wired"
  }
  var invokerFnBody = "return function " + makeLegalFunctionName(humanName) + "(" + argsList + ") {\n" + "if (arguments.length !== " + (argCount - 2) + ") {\n" + "throwBindingError('function " + humanName + " called with ' + arguments.length + ' arguments, expected " + (argCount - 2) + " args!');\n" + "}\n";
  if (needsDestructorStack) {
    invokerFnBody += "var destructors = [];\n"
  }
  var dtorStack = needsDestructorStack ? "destructors" : "null";
  var args1 = ["throwBindingError", "invoker", "fn", "runDestructors", "retType", "classParam"];
  var args2 = [throwBindingError, cppInvokerFunc, cppTargetFunc, runDestructors, argTypes[0], argTypes[1]];
  if (isClassMethodFunc) {
    invokerFnBody += "var thisWired = classParam.toWireType(" + dtorStack + ", this);\n"
  }
  for (var i = 0; i < argCount - 2; ++i) {
    invokerFnBody += "var arg" + i + "Wired = argType" + i + ".toWireType(" + dtorStack + ", arg" + i + "); // " + argTypes[i + 2].name + "\n";
    args1.push("argType" + i);
    args2.push(argTypes[i + 2])
  }
  if (isClassMethodFunc) {
    argsListWired = "thisWired" + (argsListWired.length > 0 ? ", " : "") + argsListWired
  }
  invokerFnBody += (returns ? "var rv = " : "") + "invoker(fn" + (argsListWired.length > 0 ? ", " : "") + argsListWired + ");\n";
  if (needsDestructorStack) {
    invokerFnBody += "runDestructors(destructors);\n"
  } else {
    for (var i = isClassMethodFunc ? 1 : 2; i < argTypes.length; ++i) {
      var paramName = i === 1 ? "thisWired" : "arg" + (i - 2) + "Wired";
      if (argTypes[i].destructorFunction !== null) {
        invokerFnBody += paramName + "_dtor(" + paramName + "); // " + argTypes[i].name + "\n";
        args1.push(paramName + "_dtor");
        args2.push(argTypes[i].destructorFunction)
      }
    }
  }
  if (returns) {
    invokerFnBody += "var ret = retType.fromWireType(rv);\n" + "return ret;\n"
  } else {}
  invokerFnBody += "}\n";
  args1.push(invokerFnBody);
  var invokerFunction = new_(Function, args1).apply(null, args2);
  return invokerFunction
}

function ensureOverloadTable(proto, methodName, humanName) {
  if (undefined === proto[methodName].overloadTable) {
    var prevFunc = proto[methodName];
    proto[methodName] = function () {
      if (!proto[methodName].overloadTable.hasOwnProperty(arguments.length)) {
        throwBindingError("Function '" + humanName + "' called with an invalid number of arguments (" + arguments.length + ") - expects one of (" + proto[methodName].overloadTable + ")!")
      }
      return proto[methodName].overloadTable[arguments.length].apply(this, arguments)
    };
    proto[methodName].overloadTable = [];
    proto[methodName].overloadTable[prevFunc.argCount] = prevFunc
  }
}

function exposePublicSymbol(name, value, numArguments) {
  if (Module.hasOwnProperty(name)) {
    if (undefined === numArguments || undefined !== Module[name].overloadTable && undefined !== Module[name].overloadTable[numArguments]) {
      throwBindingError("Cannot register public name '" + name + "' twice")
    }
    ensureOverloadTable(Module, name, name);
    if (Module.hasOwnProperty(numArguments)) {
      throwBindingError("Cannot register multiple overloads of a function with the same number of arguments (" + numArguments + ")!")
    }
    Module[name].overloadTable[numArguments] = value
  } else {
    Module[name] = value;
    if (undefined !== numArguments) {
      Module[name].numArguments = numArguments
    }
  }
}

function heap32VectorToArray(count, firstElement) {
  var array = [];
  for (var i = 0; i < count; i++) {
    array.push(HEAP32[(firstElement >> 2) + i])
  }
  return array
}

function replacePublicSymbol(name, value, numArguments) {
  if (!Module.hasOwnProperty(name)) {
    throwInternalError("Replacing nonexistant public symbol")
  }
  if (undefined !== Module[name].overloadTable && undefined !== numArguments) {
    Module[name].overloadTable[numArguments] = value
  } else {
    Module[name] = value;
    Module[name].argCount = numArguments
  }
}

function embind__requireFunction(signature, rawFunction) {
  signature = readLatin1String(signature);

  function makeDynCaller(dynCall) {
    var args = [];
    for (var i = 1; i < signature.length; ++i) {
      args.push("a" + i)
    }
    var name = "dynCall_" + signature + "_" + rawFunction;
    var body = "return function " + name + "(" + args.join(", ") + ") {\n";
    body += "    return dynCall(rawFunction" + (args.length ? ", " : "") + args.join(", ") + ");\n";
    body += "};\n";
    return new Function("dynCall", "rawFunction", body)(dynCall, rawFunction)
  }
  var fp;
  if (Module["FUNCTION_TABLE_" + signature] !== undefined) {
    fp = Module["FUNCTION_TABLE_" + signature][rawFunction]
  } else if (typeof FUNCTION_TABLE !== "undefined") {
    fp = FUNCTION_TABLE[rawFunction]
  } else {
    var dc = Module["dynCall_" + signature];
    if (dc === undefined) {
      dc = Module["dynCall_" + signature.replace(/f/g, "d")];
      if (dc === undefined) {
        throwBindingError("No dynCall invoker for signature: " + signature)
      }
    }
    fp = makeDynCaller(dc)
  }
  if (typeof fp !== "function") {
    throwBindingError("unknown function pointer with signature " + signature + ": " + rawFunction)
  }
  return fp
}
var UnboundTypeError = undefined;

function getTypeName(type) {
  var ptr = ___getTypeName(type);
  var rv = readLatin1String(ptr);
  _free(ptr);
  return rv
}

function throwUnboundTypeError(message, types) {
  var unboundTypes = [];
  var seen = {};

  function visit(type) {
    if (seen[type]) {
      return
    }
    if (registeredTypes[type]) {
      return
    }
    if (typeDependencies[type]) {
      typeDependencies[type].forEach(visit);
      return
    }
    unboundTypes.push(type);
    seen[type] = true
  }
  types.forEach(visit);
  throw new UnboundTypeError(message + ": " + unboundTypes.map(getTypeName).join([", "]))
}

function __embind_register_function(name, argCount, rawArgTypesAddr, signature, rawInvoker, fn) {
  var argTypes = heap32VectorToArray(argCount, rawArgTypesAddr);
  name = readLatin1String(name);
  rawInvoker = embind__requireFunction(signature, rawInvoker);
  exposePublicSymbol(name, function () {
    throwUnboundTypeError("Cannot call " + name + " due to unbound types", argTypes)
  }, argCount - 1);
  whenDependentTypesAreResolved([], argTypes, function (argTypes) {
    var invokerArgsArray = [argTypes[0], null].concat(argTypes.slice(1));
    replacePublicSymbol(name, craftInvokerFunction(name, invokerArgsArray, null, rawInvoker, fn), argCount - 1);
    return []
  })
}

function integerReadValueFromPointer(name, shift, signed) {
  switch (shift) {
  case 0:
    return signed ? function readS8FromPointer(pointer) {
      return HEAP8[pointer]
    } : function readU8FromPointer(pointer) {
      return HEAPU8[pointer]
    };
  case 1:
    return signed ? function readS16FromPointer(pointer) {
      return HEAP16[pointer >> 1]
    } : function readU16FromPointer(pointer) {
      return HEAPU16[pointer >> 1]
    };
  case 2:
    return signed ? function readS32FromPointer(pointer) {
      return HEAP32[pointer >> 2]
    } : function readU32FromPointer(pointer) {
      return HEAPU32[pointer >> 2]
    };
  default:
    throw new TypeError("Unknown integer type: " + name)
  }
}

function __embind_register_integer(primitiveType, name, size, minRange, maxRange) {
  name = readLatin1String(name);
  if (maxRange === -1) {
    maxRange = 4294967295
  }
  var shift = getShiftFromSize(size);
  var fromWireType = function (value) {
    return value
  };
  if (minRange === 0) {
    var bitshift = 32 - 8 * size;
    fromWireType = function (value) {
      return value << bitshift >>> bitshift
    }
  }
  var isUnsignedType = name.indexOf("unsigned") != -1;
  registerType(primitiveType, {
    name: name,
    "fromWireType": fromWireType,
    "toWireType": function (destructors, value) {
      if (typeof value !== "number" && typeof value !== "boolean") {
        throw new TypeError('Cannot convert "' + _embind_repr(value) + '" to ' + this.name)
      }
      if (value < minRange || value > maxRange) {
        throw new TypeError('Passing a number "' + _embind_repr(value) + '" from JS side to C/C++ side to an argument of type "' + name + '", which is outside the valid range [' + minRange + ", " + maxRange + "]!")
      }
      return isUnsignedType ? value >>> 0 : value | 0
    },
    "argPackAdvance": 8,
    "readValueFromPointer": integerReadValueFromPointer(name, shift, minRange !== 0),
    destructorFunction: null
  })
}

function __embind_register_memory_view(rawType, dataTypeIndex, name) {
  var typeMapping = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array];
  var TA = typeMapping[dataTypeIndex];

  function decodeMemoryView(handle) {
    handle = handle >> 2;
    var heap = HEAPU32;
    var size = heap[handle];
    var data = heap[handle + 1];
    return new TA(heap["buffer"], data, size)
  }
  name = readLatin1String(name);
  registerType(rawType, {
    name: name,
    "fromWireType": decodeMemoryView,
    "argPackAdvance": 8,
    "readValueFromPointer": decodeMemoryView
  }, {
    ignoreDuplicateRegistrations: true
  })
}

function __embind_register_std_string(rawType, name) {
  name = readLatin1String(name);
  var stdStringIsUTF8 = name === "std::string";
  registerType(rawType, {
    name: name,
    "fromWireType": function (value) {
      var length = HEAPU32[value >> 2];
      var str;
      if (stdStringIsUTF8) {
        var endChar = HEAPU8[value + 4 + length];
        var endCharSwap = 0;
        if (endChar != 0) {
          endCharSwap = endChar;
          HEAPU8[value + 4 + length] = 0
        }
        var decodeStartPtr = value + 4;
        for (var i = 0; i <= length; ++i) {
          var currentBytePtr = value + 4 + i;
          if (HEAPU8[currentBytePtr] == 0) {
            var stringSegment = UTF8ToString(decodeStartPtr);
            if (str === undefined) str = stringSegment;
            else {
              str += String.fromCharCode(0);
              str += stringSegment
            }
            decodeStartPtr = currentBytePtr + 1
          }
        }
        if (endCharSwap != 0) HEAPU8[value + 4 + length] = endCharSwap
      } else {
        var a = new Array(length);
        for (var i = 0; i < length; ++i) {
          a[i] = String.fromCharCode(HEAPU8[value + 4 + i])
        }
        str = a.join("")
      }
      _free(value);
      return str
    },
    "toWireType": function (destructors, value) {
      if (value instanceof ArrayBuffer) {
        value = new Uint8Array(value)
      }
      var getLength;
      var valueIsOfTypeString = typeof value === "string";
      if (!(valueIsOfTypeString || value instanceof Uint8Array || value instanceof Uint8ClampedArray || value instanceof Int8Array)) {
        throwBindingError("Cannot pass non-string to std::string")
      }
      if (stdStringIsUTF8 && valueIsOfTypeString) {
        getLength = function () {
          return lengthBytesUTF8(value)
        }
      } else {
        getLength = function () {
          return value.length
        }
      }
      var length = getLength();
      var ptr = _malloc(4 + length + 1);
      HEAPU32[ptr >> 2] = length;
      if (stdStringIsUTF8 && valueIsOfTypeString) {
        stringToUTF8(value, ptr + 4, length + 1)
      } else {
        if (valueIsOfTypeString) {
          for (var i = 0; i < length; ++i) {
            var charCode = value.charCodeAt(i);
            if (charCode > 255) {
              _free(ptr);
              throwBindingError("String has UTF-16 code units that do not fit in 8 bits")
            }
            HEAPU8[ptr + 4 + i] = charCode
          }
        } else {
          for (var i = 0; i < length; ++i) {
            HEAPU8[ptr + 4 + i] = value[i]
          }
        }
      }
      if (destructors !== null) {
        destructors.push(_free, ptr)
      }
      return ptr
    },
    "argPackAdvance": 8,
    "readValueFromPointer": simpleReadValueFromPointer,
    destructorFunction: function (ptr) {
      _free(ptr)
    }
  })
}

function __embind_register_std_wstring(rawType, charSize, name) {
  name = readLatin1String(name);
  var getHeap, shift;
  if (charSize === 2) {
    getHeap = function () {
      return HEAPU16
    };
    shift = 1
  } else if (charSize === 4) {
    getHeap = function () {
      return HEAPU32
    };
    shift = 2
  }
  registerType(rawType, {
    name: name,
    "fromWireType": function (value) {
      var HEAP = getHeap();
      var length = HEAPU32[value >> 2];
      var a = new Array(length);
      var start = value + 4 >> shift;
      for (var i = 0; i < length; ++i) {
        a[i] = String.fromCharCode(HEAP[start + i])
      }
      _free(value);
      return a.join("")
    },
    "toWireType": function (destructors, value) {
      var HEAP = getHeap();
      var length = value.length;
      var ptr = _malloc(4 + length * charSize);
      HEAPU32[ptr >> 2] = length;
      var start = ptr + 4 >> shift;
      for (var i = 0; i < length; ++i) {
        HEAP[start + i] = value.charCodeAt(i)
      }
      if (destructors !== null) {
        destructors.push(_free, ptr)
      }
      return ptr
    },
    "argPackAdvance": 8,
    "readValueFromPointer": simpleReadValueFromPointer,
    destructorFunction: function (ptr) {
      _free(ptr)
    }
  })
}

function __embind_register_void(rawType, name) {
  name = readLatin1String(name);
  registerType(rawType, {
    isVoid: true,
    name: name,
    "argPackAdvance": 0,
    "fromWireType": function () {
      return undefined
    },
    "toWireType": function (destructors, o) {
      return undefined
    }
  })
}

function _abort() {
  Module["abort"]()
}

function _emscripten_get_heap_size() {
  return HEAP8.length
}

function abortOnCannotGrowMemory(requestedSize) {
  abort("OOM")
}

function _emscripten_resize_heap(requestedSize) {
  abortOnCannotGrowMemory(requestedSize)
}

function _exit(status) {
  exit(status)
}

function _getenv(name) {
  if (name === 0) return 0;
  name = UTF8ToString(name);
  if (!ENV.hasOwnProperty(name)) return 0;
  if (_getenv.ret) _free(_getenv.ret);
  _getenv.ret = allocateUTF8(ENV[name]);
  return _getenv.ret
}

function _gettimeofday(ptr) {
  var now = Date.now();
  HEAP32[ptr >> 2] = now / 1e3 | 0;
  HEAP32[ptr + 4 >> 2] = now % 1e3 * 1e3 | 0;
  return 0
}

function _llvm_exp2_f32(x) {
  return Math.pow(2, x)
}

function _llvm_stackrestore(p) {
  var self = _llvm_stacksave;
  var ret = self.LLVM_SAVEDSTACKS[p];
  self.LLVM_SAVEDSTACKS.splice(p, 1);
  stackRestore(ret)
}

function _llvm_stacksave() {
  var self = _llvm_stacksave;
  if (!self.LLVM_SAVEDSTACKS) {
    self.LLVM_SAVEDSTACKS = []
  }
  self.LLVM_SAVEDSTACKS.push(stackSave());
  return self.LLVM_SAVEDSTACKS.length - 1
}
var ___tm_current = 59056;
var ___tm_timezone = (stringToUTF8("GMT", 59104, 4), 59104);

function _tzset() {
  if (_tzset.called) return;
  _tzset.called = true;
  HEAP32[__get_timezone() >> 2] = (new Date).getTimezoneOffset() * 60;
  var winter = new Date(2e3, 0, 1);
  var summer = new Date(2e3, 6, 1);
  HEAP32[__get_daylight() >> 2] = Number(winter.getTimezoneOffset() != summer.getTimezoneOffset());

  function extractZone(date) {
    var match = date.toTimeString().match(/\(([A-Za-z ]+)\)$/);
    return match ? match[1] : "GMT"
  }
  var winterName = extractZone(winter);
  var summerName = extractZone(summer);
  var winterNamePtr = allocate(intArrayFromString(winterName), "i8", ALLOC_NORMAL);
  var summerNamePtr = allocate(intArrayFromString(summerName), "i8", ALLOC_NORMAL);
  if (summer.getTimezoneOffset() < winter.getTimezoneOffset()) {
    HEAP32[__get_tzname() >> 2] = winterNamePtr;
    HEAP32[__get_tzname() + 4 >> 2] = summerNamePtr
  } else {
    HEAP32[__get_tzname() >> 2] = summerNamePtr;
    HEAP32[__get_tzname() + 4 >> 2] = winterNamePtr
  }
}

function _localtime_r(time, tmPtr) {
  _tzset();
  var date = new Date(HEAP32[time >> 2] * 1e3);
  HEAP32[tmPtr >> 2] = date.getSeconds();
  HEAP32[tmPtr + 4 >> 2] = date.getMinutes();
  HEAP32[tmPtr + 8 >> 2] = date.getHours();
  HEAP32[tmPtr + 12 >> 2] = date.getDate();
  HEAP32[tmPtr + 16 >> 2] = date.getMonth();
  HEAP32[tmPtr + 20 >> 2] = date.getFullYear() - 1900;
  HEAP32[tmPtr + 24 >> 2] = date.getDay();
  var start = new Date(date.getFullYear(), 0, 1);
  var yday = (date.getTime() - start.getTime()) / (1e3 * 60 * 60 * 24) | 0;
  HEAP32[tmPtr + 28 >> 2] = yday;
  HEAP32[tmPtr + 36 >> 2] = -(date.getTimezoneOffset() * 60);
  var summerOffset = new Date(2e3, 6, 1).getTimezoneOffset();
  var winterOffset = start.getTimezoneOffset();
  var dst = (summerOffset != winterOffset && date.getTimezoneOffset() == Math.min(winterOffset, summerOffset)) | 0;
  HEAP32[tmPtr + 32 >> 2] = dst;
  var zonePtr = HEAP32[__get_tzname() + (dst ? 4 : 0) >> 2];
  HEAP32[tmPtr + 40 >> 2] = zonePtr;
  return tmPtr
}

function _localtime(time) {
  return _localtime_r(time, ___tm_current)
}

function _longjmp(env, value) {
  _setThrew(env, value || 1);
  throw "longjmp"
}

function _emscripten_memcpy_big(dest, src, num) {
  HEAPU8.set(HEAPU8.subarray(src, src + num), dest)
}

function _pthread_cond_wait() {
  return 0
}

function __isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function __arraySum(array, index) {
  var sum = 0;
  for (var i = 0; i <= index; sum += array[i++]);
  return sum
}
var __MONTH_DAYS_LEAP = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
var __MONTH_DAYS_REGULAR = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function __addDays(date, days) {
  var newDate = new Date(date.getTime());
  while (days > 0) {
    var leap = __isLeapYear(newDate.getFullYear());
    var currentMonth = newDate.getMonth();
    var daysInCurrentMonth = (leap ? __MONTH_DAYS_LEAP : __MONTH_DAYS_REGULAR)[currentMonth];
    if (days > daysInCurrentMonth - newDate.getDate()) {
      days -= daysInCurrentMonth - newDate.getDate() + 1;
      newDate.setDate(1);
      if (currentMonth < 11) {
        newDate.setMonth(currentMonth + 1)
      } else {
        newDate.setMonth(0);
        newDate.setFullYear(newDate.getFullYear() + 1)
      }
    } else {
      newDate.setDate(newDate.getDate() + days);
      return newDate
    }
  }
  return newDate
}

function _strftime(s, maxsize, format, tm) {
  var tm_zone = HEAP32[tm + 40 >> 2];
  var date = {
    tm_sec: HEAP32[tm >> 2],
    tm_min: HEAP32[tm + 4 >> 2],
    tm_hour: HEAP32[tm + 8 >> 2],
    tm_mday: HEAP32[tm + 12 >> 2],
    tm_mon: HEAP32[tm + 16 >> 2],
    tm_year: HEAP32[tm + 20 >> 2],
    tm_wday: HEAP32[tm + 24 >> 2],
    tm_yday: HEAP32[tm + 28 >> 2],
    tm_isdst: HEAP32[tm + 32 >> 2],
    tm_gmtoff: HEAP32[tm + 36 >> 2],
    tm_zone: tm_zone ? UTF8ToString(tm_zone) : ""
  };
  var pattern = UTF8ToString(format);
  var EXPANSION_RULES_1 = {
    "%c": "%a %b %d %H:%M:%S %Y",
    "%D": "%m/%d/%y",
    "%F": "%Y-%m-%d",
    "%h": "%b",
    "%r": "%I:%M:%S %p",
    "%R": "%H:%M",
    "%T": "%H:%M:%S",
    "%x": "%m/%d/%y",
    "%X": "%H:%M:%S"
  };
  for (var rule in EXPANSION_RULES_1) {
    pattern = pattern.replace(new RegExp(rule, "g"), EXPANSION_RULES_1[rule])
  }
  var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function leadingSomething(value, digits, character) {
    var str = typeof value === "number" ? value.toString() : value || "";
    while (str.length < digits) {
      str = character[0] + str
    }
    return str
  }

  function leadingNulls(value, digits) {
    return leadingSomething(value, digits, "0")
  }

  function compareByDay(date1, date2) {
    function sgn(value) {
      return value < 0 ? -1 : value > 0 ? 1 : 0
    }
    var compare;
    if ((compare = sgn(date1.getFullYear() - date2.getFullYear())) === 0) {
      if ((compare = sgn(date1.getMonth() - date2.getMonth())) === 0) {
        compare = sgn(date1.getDate() - date2.getDate())
      }
    }
    return compare
  }

  function getFirstWeekStartDate(janFourth) {
    switch (janFourth.getDay()) {
    case 0:
      return new Date(janFourth.getFullYear() - 1, 11, 29);
    case 1:
      return janFourth;
    case 2:
      return new Date(janFourth.getFullYear(), 0, 3);
    case 3:
      return new Date(janFourth.getFullYear(), 0, 2);
    case 4:
      return new Date(janFourth.getFullYear(), 0, 1);
    case 5:
      return new Date(janFourth.getFullYear() - 1, 11, 31);
    case 6:
      return new Date(janFourth.getFullYear() - 1, 11, 30)
    }
  }

  function getWeekBasedYear(date) {
    var thisDate = __addDays(new Date(date.tm_year + 1900, 0, 1), date.tm_yday);
    var janFourthThisYear = new Date(thisDate.getFullYear(), 0, 4);
    var janFourthNextYear = new Date(thisDate.getFullYear() + 1, 0, 4);
    var firstWeekStartThisYear = getFirstWeekStartDate(janFourthThisYear);
    var firstWeekStartNextYear = getFirstWeekStartDate(janFourthNextYear);
    if (compareByDay(firstWeekStartThisYear, thisDate) <= 0) {
      if (compareByDay(firstWeekStartNextYear, thisDate) <= 0) {
        return thisDate.getFullYear() + 1
      } else {
        return thisDate.getFullYear()
      }
    } else {
      return thisDate.getFullYear() - 1
    }
  }
  var EXPANSION_RULES_2 = {
    "%a": function (date) {
      return WEEKDAYS[date.tm_wday].substring(0, 3)
    },
    "%A": function (date) {
      return WEEKDAYS[date.tm_wday]
    },
    "%b": function (date) {
      return MONTHS[date.tm_mon].substring(0, 3)
    },
    "%B": function (date) {
      return MONTHS[date.tm_mon]
    },
    "%C": function (date) {
      var year = date.tm_year + 1900;
      return leadingNulls(year / 100 | 0, 2)
    },
    "%d": function (date) {
      return leadingNulls(date.tm_mday, 2)
    },
    "%e": function (date) {
      return leadingSomething(date.tm_mday, 2, " ")
    },
    "%g": function (date) {
      return getWeekBasedYear(date).toString().substring(2)
    },
    "%G": function (date) {
      return getWeekBasedYear(date)
    },
    "%H": function (date) {
      return leadingNulls(date.tm_hour, 2)
    },
    "%I": function (date) {
      var twelveHour = date.tm_hour;
      if (twelveHour == 0) twelveHour = 12;
      else if (twelveHour > 12) twelveHour -= 12;
      return leadingNulls(twelveHour, 2)
    },
    "%j": function (date) {
      return leadingNulls(date.tm_mday + __arraySum(__isLeapYear(date.tm_year + 1900) ? __MONTH_DAYS_LEAP : __MONTH_DAYS_REGULAR, date.tm_mon - 1), 3)
    },
    "%m": function (date) {
      return leadingNulls(date.tm_mon + 1, 2)
    },
    "%M": function (date) {
      return leadingNulls(date.tm_min, 2)
    },
    "%n": function () {
      return "\n"
    },
    "%p": function (date) {
      if (date.tm_hour >= 0 && date.tm_hour < 12) {
        return "AM"
      } else {
        return "PM"
      }
    },
    "%S": function (date) {
      return leadingNulls(date.tm_sec, 2)
    },
    "%t": function () {
      return "\t"
    },
    "%u": function (date) {
      var day = new Date(date.tm_year + 1900, date.tm_mon + 1, date.tm_mday, 0, 0, 0, 0);
      return day.getDay() || 7
    },
    "%U": function (date) {
      var janFirst = new Date(date.tm_year + 1900, 0, 1);
      var firstSunday = janFirst.getDay() === 0 ? janFirst : __addDays(janFirst, 7 - janFirst.getDay());
      var endDate = new Date(date.tm_year + 1900, date.tm_mon, date.tm_mday);
      if (compareByDay(firstSunday, endDate) < 0) {
        var februaryFirstUntilEndMonth = __arraySum(__isLeapYear(endDate.getFullYear()) ? __MONTH_DAYS_LEAP : __MONTH_DAYS_REGULAR, endDate.getMonth() - 1) - 31;
        var firstSundayUntilEndJanuary = 31 - firstSunday.getDate();
        var days = firstSundayUntilEndJanuary + februaryFirstUntilEndMonth + endDate.getDate();
        return leadingNulls(Math.ceil(days / 7), 2)
      }
      return compareByDay(firstSunday, janFirst) === 0 ? "01" : "00"
    },
    "%V": function (date) {
      var janFourthThisYear = new Date(date.tm_year + 1900, 0, 4);
      var janFourthNextYear = new Date(date.tm_year + 1901, 0, 4);
      var firstWeekStartThisYear = getFirstWeekStartDate(janFourthThisYear);
      var firstWeekStartNextYear = getFirstWeekStartDate(janFourthNextYear);
      var endDate = __addDays(new Date(date.tm_year + 1900, 0, 1), date.tm_yday);
      if (compareByDay(endDate, firstWeekStartThisYear) < 0) {
        return "53"
      }
      if (compareByDay(firstWeekStartNextYear, endDate) <= 0) {
        return "01"
      }
      var daysDifference;
      if (firstWeekStartThisYear.getFullYear() < date.tm_year + 1900) {
        daysDifference = date.tm_yday + 32 - firstWeekStartThisYear.getDate()
      } else {
        daysDifference = date.tm_yday + 1 - firstWeekStartThisYear.getDate()
      }
      return leadingNulls(Math.ceil(daysDifference / 7), 2)
    },
    "%w": function (date) {
      var day = new Date(date.tm_year + 1900, date.tm_mon + 1, date.tm_mday, 0, 0, 0, 0);
      return day.getDay()
    },
    "%W": function (date) {
      var janFirst = new Date(date.tm_year, 0, 1);
      var firstMonday = janFirst.getDay() === 1 ? janFirst : __addDays(janFirst, janFirst.getDay() === 0 ? 1 : 7 - janFirst.getDay() + 1);
      var endDate = new Date(date.tm_year + 1900, date.tm_mon, date.tm_mday);
      if (compareByDay(firstMonday, endDate) < 0) {
        var februaryFirstUntilEndMonth = __arraySum(__isLeapYear(endDate.getFullYear()) ? __MONTH_DAYS_LEAP : __MONTH_DAYS_REGULAR, endDate.getMonth() - 1) - 31;
        var firstMondayUntilEndJanuary = 31 - firstMonday.getDate();
        var days = firstMondayUntilEndJanuary + februaryFirstUntilEndMonth + endDate.getDate();
        return leadingNulls(Math.ceil(days / 7), 2)
      }
      return compareByDay(firstMonday, janFirst) === 0 ? "01" : "00"
    },
    "%y": function (date) {
      return (date.tm_year + 1900).toString().substring(2)
    },
    "%Y": function (date) {
      return date.tm_year + 1900
    },
    "%z": function (date) {
      var off = date.tm_gmtoff;
      var ahead = off >= 0;
      off = Math.abs(off) / 60;
      off = off / 60 * 100 + off % 60;
      return (ahead ? "+" : "-") + String("0000" + off).slice(-4)
    },
    "%Z": function (date) {
      return date.tm_zone
    },
    "%%": function () {
      return "%"
    }
  };
  for (var rule in EXPANSION_RULES_2) {
    if (pattern.indexOf(rule) >= 0) {
      pattern = pattern.replace(new RegExp(rule, "g"), EXPANSION_RULES_2[rule](date))
    }
  }
  var bytes = intArrayFromString(pattern, false);
  if (bytes.length > maxsize) {
    return 0
  }
  writeArrayToMemory(bytes, s);
  return bytes.length - 1
}

function _strftime_l(s, maxsize, format, tm) {
  return _strftime(s, maxsize, format, tm)
}

function _time(ptr) {
  var ret = Date.now() / 1e3 | 0;
  if (ptr) {
    HEAP32[ptr >> 2] = ret
  }
  return ret
}
if (ENVIRONMENT_IS_NODE) {
  _emscripten_get_now = function _emscripten_get_now_actual() {
    var t = process["hrtime"]();
    return t[0] * 1e3 + t[1] / 1e6
  }
} else if (typeof dateNow !== "undefined") {
  _emscripten_get_now = dateNow
} else if (typeof performance === "object" && performance && typeof performance["now"] === "function") {
  _emscripten_get_now = function () {
    return performance["now"]()
  }
} else {
  _emscripten_get_now = Date.now
}
FS.staticInit();
if (ENVIRONMENT_IS_NODE) {
  var fs = require("fs");
  var NODEJS_PATH = require("path");
  NODEFS.staticInit()
}
embind_init_charCodes();
BindingError = Module["BindingError"] = extendError(Error, "BindingError");
InternalError = Module["InternalError"] = extendError(Error, "InternalError");
init_emval();
UnboundTypeError = Module["UnboundTypeError"] = extendError(Error, "UnboundTypeError");

function intArrayFromString(stringy, dontAddNull, length) {
  var len = length > 0 ? length : lengthBytesUTF8(stringy) + 1;
  var u8array = new Array(len);
  var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
  if (dontAddNull) u8array.length = numBytesWritten;
  return u8array
}

function invoke_ii(index, a1) {
  var sp = stackSave();
  try {
    return dynCall_ii(index, a1)
  } catch (e) {
    stackRestore(sp);
    if (e !== e + 0 && e !== "longjmp") throw e;
    _setThrew(1, 0)
  }
}

function invoke_iii(index, a1, a2) {
  var sp = stackSave();
  try {
    return dynCall_iii(index, a1, a2)
  } catch (e) {
    stackRestore(sp);
    if (e !== e + 0 && e !== "longjmp") throw e;
    _setThrew(1, 0)
  }
}

function invoke_iiii(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    return dynCall_iiii(index, a1, a2, a3)
  } catch (e) {
    stackRestore(sp);
    if (e !== e + 0 && e !== "longjmp") throw e;
    _setThrew(1, 0)
  }
}

function invoke_vi(index, a1) {
  var sp = stackSave();
  try {
    dynCall_vi(index, a1)
  } catch (e) {
    stackRestore(sp);
    if (e !== e + 0 && e !== "longjmp") throw e;
    _setThrew(1, 0)
  }
}

function invoke_vii(index, a1, a2) {
  var sp = stackSave();
  try {
    dynCall_vii(index, a1, a2)
  } catch (e) {
    stackRestore(sp);
    if (e !== e + 0 && e !== "longjmp") throw e;
    _setThrew(1, 0)
  }
}

function invoke_viii(index, a1, a2, a3) {
  var sp = stackSave();
  try {
    dynCall_viii(index, a1, a2, a3)
  } catch (e) {
    stackRestore(sp);
    if (e !== e + 0 && e !== "longjmp") throw e;
    _setThrew(1, 0)
  }
}

function invoke_viiii(index, a1, a2, a3, a4) {
  var sp = stackSave();
  try {
    dynCall_viiii(index, a1, a2, a3, a4)
  } catch (e) {
    stackRestore(sp);
    if (e !== e + 0 && e !== "longjmp") throw e;
    _setThrew(1, 0)
  }
}
var asmGlobalArg = {};
var asmLibraryArg = {
  "d": abort,
  "e": setTempRet0,
  "i": getTempRet0,
  "r": invoke_ii,
  "V": invoke_iii,
  "N": invoke_iiii,
  "q": invoke_vi,
  "F": invoke_vii,
  "E": invoke_viii,
  "t": invoke_viiii,
  "ga": ___buildEnvironment,
  "fa": ___clock_gettime,
  "g": ___cxa_allocate_exception,
  "f": ___cxa_throw,
  "ea": ___cxa_uncaught_exception,
  "D": ___lock,
  "da": ___map_file,
  "C": ___setErrNo,
  "ca": ___syscall10,
  "ba": ___syscall140,
  "aa": ___syscall145,
  "B": ___syscall146,
  "s": ___syscall221,
  "A": ___syscall5,
  "z": ___syscall54,
  "u": ___syscall6,
  "$": ___syscall91,
  "p": ___unlock,
  "_": __embind_register_bool,
  "y": __embind_register_constant,
  "Z": __embind_register_emval,
  "x": __embind_register_float,
  "k": __embind_register_function,
  "l": __embind_register_integer,
  "j": __embind_register_memory_view,
  "w": __embind_register_std_string,
  "Y": __embind_register_std_wstring,
  "X": __embind_register_void,
  "b": _abort,
  "W": _emscripten_asm_const_ii,
  "U": _emscripten_asm_const_iiddddddddddddd,
  "T": _emscripten_asm_const_iiiid,
  "S": _emscripten_asm_const_iiiiiii,
  "R": _emscripten_asm_const_iiiiiiiidddddddddddddddddddddddddi,
  "Q": _emscripten_get_heap_size,
  "P": _emscripten_memcpy_big,
  "O": _emscripten_resize_heap,
  "c": _exit,
  "o": _getenv,
  "v": _gettimeofday,
  "M": _llvm_exp2_f32,
  "n": _llvm_stackrestore,
  "m": _llvm_stacksave,
  "L": _localtime,
  "h": _longjmp,
  "K": _pthread_cond_wait,
  "J": _strftime,
  "I": _strftime_l,
  "H": _time,
  "G": abortOnCannotGrowMemory,
  "a": DYNAMICTOP_PTR
};
var asm = Module["asm"](asmGlobalArg, asmLibraryArg, buffer);
Module["asm"] = asm;
var __GLOBAL__sub_I_ARToolKitJS_cpp = Module["__GLOBAL__sub_I_ARToolKitJS_cpp"] = function () {
  return Module["asm"]["ha"].apply(null, arguments)
};
var __GLOBAL__sub_I_bind_cpp = Module["__GLOBAL__sub_I_bind_cpp"] = function () {
  return Module["asm"]["ia"].apply(null, arguments)
};
var __GLOBAL__sub_I_iostream_cpp = Module["__GLOBAL__sub_I_iostream_cpp"] = function () {
  return Module["asm"]["ja"].apply(null, arguments)
};
var __ZSt18uncaught_exceptionv = Module["__ZSt18uncaught_exceptionv"] = function () {
  return Module["asm"]["ka"].apply(null, arguments)
};
var ___emscripten_environ_constructor = Module["___emscripten_environ_constructor"] = function () {
  return Module["asm"]["la"].apply(null, arguments)
};
var ___errno_location = Module["___errno_location"] = function () {
  return Module["asm"]["ma"].apply(null, arguments)
};
var ___getTypeName = Module["___getTypeName"] = function () {
  return Module["asm"]["na"].apply(null, arguments)
};
var __get_daylight = Module["__get_daylight"] = function () {
  return Module["asm"]["oa"].apply(null, arguments)
};
var __get_timezone = Module["__get_timezone"] = function () {
  return Module["asm"]["pa"].apply(null, arguments)
};
var __get_tzname = Module["__get_tzname"] = function () {
  return Module["asm"]["qa"].apply(null, arguments)
};
var _free = Module["_free"] = function () {
  return Module["asm"]["ra"].apply(null, arguments)
};
var _malloc = Module["_malloc"] = function () {
  return Module["asm"]["sa"].apply(null, arguments)
};
var _setThrew = Module["_setThrew"] = function () {
  return Module["asm"]["ta"].apply(null, arguments)
};
var stackAlloc = Module["stackAlloc"] = function () {
  return Module["asm"]["Xa"].apply(null, arguments)
};
var stackRestore = Module["stackRestore"] = function () {
  return Module["asm"]["Ya"].apply(null, arguments)
};
var stackSave = Module["stackSave"] = function () {
  return Module["asm"]["Za"].apply(null, arguments)
};
var dynCall_di = Module["dynCall_di"] = function () {
  return Module["asm"]["ua"].apply(null, arguments)
};
var dynCall_dii = Module["dynCall_dii"] = function () {
  return Module["asm"]["va"].apply(null, arguments)
};
var dynCall_i = Module["dynCall_i"] = function () {
  return Module["asm"]["wa"].apply(null, arguments)
};
var dynCall_ii = Module["dynCall_ii"] = function () {
  return Module["asm"]["xa"].apply(null, arguments)
};
var dynCall_iidiiii = Module["dynCall_iidiiii"] = function () {
  return Module["asm"]["ya"].apply(null, arguments)
};
var dynCall_iii = Module["dynCall_iii"] = function () {
  return Module["asm"]["za"].apply(null, arguments)
};
var dynCall_iiii = Module["dynCall_iiii"] = function () {
  return Module["asm"]["Aa"].apply(null, arguments)
};
var dynCall_iiiii = Module["dynCall_iiiii"] = function () {
  return Module["asm"]["Ba"].apply(null, arguments)
};
var dynCall_iiiiid = Module["dynCall_iiiiid"] = function () {
  return Module["asm"]["Ca"].apply(null, arguments)
};
var dynCall_iiiiii = Module["dynCall_iiiiii"] = function () {
  return Module["asm"]["Da"].apply(null, arguments)
};
var dynCall_iiiiiid = Module["dynCall_iiiiiid"] = function () {
  return Module["asm"]["Ea"].apply(null, arguments)
};
var dynCall_iiiiiii = Module["dynCall_iiiiiii"] = function () {
  return Module["asm"]["Fa"].apply(null, arguments)
};
var dynCall_iiiiiiii = Module["dynCall_iiiiiiii"] = function () {
  return Module["asm"]["Ga"].apply(null, arguments)
};
var dynCall_iiiiiiiii = Module["dynCall_iiiiiiiii"] = function () {
  return Module["asm"]["Ha"].apply(null, arguments)
};
var dynCall_iiiiij = Module["dynCall_iiiiij"] = function () {
  return Module["asm"]["Ia"].apply(null, arguments)
};
var dynCall_jiji = Module["dynCall_jiji"] = function () {
  return Module["asm"]["Ja"].apply(null, arguments)
};
var dynCall_v = Module["dynCall_v"] = function () {
  return Module["asm"]["Ka"].apply(null, arguments)
};
var dynCall_vi = Module["dynCall_vi"] = function () {
  return Module["asm"]["La"].apply(null, arguments)
};
var dynCall_vid = Module["dynCall_vid"] = function () {
  return Module["asm"]["Ma"].apply(null, arguments)
};
var dynCall_vif = Module["dynCall_vif"] = function () {
  return Module["asm"]["Na"].apply(null, arguments)
};
var dynCall_vii = Module["dynCall_vii"] = function () {
  return Module["asm"]["Oa"].apply(null, arguments)
};
var dynCall_viid = Module["dynCall_viid"] = function () {
  return Module["asm"]["Pa"].apply(null, arguments)
};
var dynCall_viif = Module["dynCall_viif"] = function () {
  return Module["asm"]["Qa"].apply(null, arguments)
};
var dynCall_viii = Module["dynCall_viii"] = function () {
  return Module["asm"]["Ra"].apply(null, arguments)
};
var dynCall_viiii = Module["dynCall_viiii"] = function () {
  return Module["asm"]["Sa"].apply(null, arguments)
};
var dynCall_viiiii = Module["dynCall_viiiii"] = function () {
  return Module["asm"]["Ta"].apply(null, arguments)
};
var dynCall_viiiiii = Module["dynCall_viiiiii"] = function () {
  return Module["asm"]["Ua"].apply(null, arguments)
};
var dynCall_viiiiiii = Module["dynCall_viiiiiii"] = function () {
  return Module["asm"]["Va"].apply(null, arguments)
};
var dynCall_viijii = Module["dynCall_viijii"] = function () {
  return Module["asm"]["Wa"].apply(null, arguments)
};
Module["asm"] = asm;

function ExitStatus(status) {
  this.name = "ExitStatus";
  this.message = "Program terminated with exit(" + status + ")";
  this.status = status
}
ExitStatus.prototype = new Error;
ExitStatus.prototype.constructor = ExitStatus;
dependenciesFulfilled = function runCaller() {
  if (!Module["calledRun"]) run();
  if (!Module["calledRun"]) dependenciesFulfilled = runCaller
};

function run(args) {
  args = args || Module["arguments"];
  if (runDependencies > 0) {
    return
  }
  preRun();
  if (runDependencies > 0) return;
  if (Module["calledRun"]) return;

  function doRun() {
    if (Module["calledRun"]) return;
    Module["calledRun"] = true;
    if (ABORT) return;
    ensureInitRuntime();
    preMain();
    if (Module["onRuntimeInitialized"]) Module["onRuntimeInitialized"]();
    postRun()
  }
  if (Module["setStatus"]) {
    Module["setStatus"]("Running...");
    setTimeout(function () {
      setTimeout(function () {
        Module["setStatus"]("")
      }, 1);
      doRun()
    }, 1)
  } else {
    doRun()
  }
}
Module["run"] = run;

function exit(status, implicit) {
  if (implicit && Module["noExitRuntime"] && status === 0) {
    return
  }
  if (Module["noExitRuntime"]) {} else {
    ABORT = true;
    EXITSTATUS = status;
    exitRuntime();
    if (Module["onExit"]) Module["onExit"](status)
  }
  Module["quit"](status, new ExitStatus(status))
}

function abort(what) {
  if (Module["onAbort"]) {
    Module["onAbort"](what)
  }
  if (what !== undefined) {
    out(what);
    err(what);
    what = JSON.stringify(what)
  } else {
    what = ""
  }
  ABORT = true;
  EXITSTATUS = 1;
  throw "abort(" + what + "). Build with -s ASSERTIONS=1 for more info."
}
Module["abort"] = abort;
if (Module["preInit"]) {
  if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
  while (Module["preInit"].length > 0) {
    Module["preInit"].pop()()
  }
}
Module["noExitRuntime"] = true;
run();